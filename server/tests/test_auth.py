"""The Cognito imitation: authorize page, PKCE code exchange, tokens, refresh, logout."""

from __future__ import annotations

import base64
import hashlib
import json
import unittest
from urllib.parse import parse_qs, urlsplit

from server.auth_stub import jwt
from server.auth_stub.oauth import pkce_challenge
from server.auth_stub.tokens import stub_sub
from server.tests.helpers import FixedClock, new_client, teardown

CLIENT = "html-bible-dev"
REDIRECT = "http://localhost:5173/"
VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"  # RFC 7636 appendix B


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.clock = FixedClock()
        self.client = new_client(clock=self.clock, token_ttl=10)

    def tearDown(self):
        teardown(self.client)

    def authorize(self, name="Maria", idp="Google", redirect=REDIRECT, challenge=None, state="st-1"):
        form = {
            "response_type": "code", "client_id": CLIENT, "redirect_uri": redirect, "state": state,
            "code_challenge": challenge or pkce_challenge(VERIFIER), "code_challenge_method": "S256",
            "identity_provider": idp, "name": name, "action": "allow",
        }
        status, headers, _ = self.client.raw("POST", "/oauth2/authorize", form=form)
        self.assertEqual(status, 302)
        return headers["Location"]

    def code(self, **kwargs):
        location = self.authorize(**kwargs)
        query = parse_qs(urlsplit(location).query)
        return query["code"][0]

    def exchange(self, code, verifier=VERIFIER, redirect=REDIRECT, client=CLIENT):
        return self.client.call("POST", "/oauth2/token", form={
            "grant_type": "authorization_code", "client_id": client, "code": code,
            "redirect_uri": redirect, "code_verifier": verifier,
        })

    # --- tests ---

    def test_pkce_vector_rfc7636(self):
        self.assertEqual(pkce_challenge(VERIFIER), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")

    def test_authorize_page_is_marked_as_stub(self):
        status, headers, page = self.client.raw(
            "GET", "/oauth2/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2F"
                   "&state=s&code_challenge=abc&code_challenge_method=S256&identity_provider=SignInWithApple")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("DEVELOPMENT STUB", page)
        self.assertIn("Sign in as… (Apple)", page)
        self.assertIn('name="name"', page)

    def test_authorize_without_provider_offers_all_three(self):
        status, _, page = self.client.raw(
            "GET", "/oauth2/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2F"
                   "&code_challenge=abc&code_challenge_method=S256")
        self.assertEqual(status, 200)
        for idp in ("Google", "SignInWithApple", "Microsoft"):
            self.assertIn(f'value="{idp}"', page)

    def test_authorize_refuses_foreign_redirect(self):
        status, headers, page = self.client.raw(
            "GET", "/oauth2/authorize?response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fevil.example%2F"
                   "&code_challenge=abc&code_challenge_method=S256")
        self.assertEqual(status, 400)
        self.assertNotIn("Location", headers)

    def test_authorize_requires_s256(self):
        status, headers, _ = self.client.raw(
            "GET", "/oauth2/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2F"
                   "&state=s1&code_challenge=abc&code_challenge_method=plain")
        self.assertEqual(status, 302)
        query = parse_qs(urlsplit(headers["Location"]).query)
        self.assertEqual(query["error"], ["invalid_request"])
        self.assertEqual(query["state"], ["s1"])

    def test_cancel_redirects_with_access_denied(self):
        status, headers, _ = self.client.raw("POST", "/oauth2/authorize", form={
            "response_type": "code", "client_id": CLIENT, "redirect_uri": REDIRECT, "state": "s",
            "code_challenge": "abc", "code_challenge_method": "S256", "identity_provider": "Google",
            "action": "deny",
        })
        self.assertEqual(status, 302)
        self.assertIn("error=access_denied", headers["Location"])

    def test_redirect_keeps_state_and_existing_query(self):
        location = self.authorize(redirect="http://localhost:8787/index.html?x=1", state="abc")
        query = parse_qs(urlsplit(location).query)
        self.assertEqual(query["x"], ["1"])
        self.assertEqual(query["state"], ["abc"])
        self.assertTrue(query["code"][0])

    def test_code_exchange_issues_cognito_like_tokens(self):
        status, body = self.exchange(self.code(name="Maria", idp="Microsoft"))
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"access_token", "id_token", "refresh_token", "token_type", "expires_in"})
        self.assertEqual(body["token_type"], "Bearer")
        self.assertEqual(body["expires_in"], 10)
        claims = jwt.decode(body["id_token"], self.client.app.config.jwt_secret, self.clock())
        self.assertEqual(claims["sub"], stub_sub("microsoft", "Maria"))
        self.assertEqual(claims["name"], "Maria")
        self.assertEqual(claims["aud"], CLIENT)
        self.assertEqual(claims["iss"], self.client.app.config.issuer)
        self.assertEqual(claims["token_use"], "id")
        self.assertEqual(claims["identities"][0]["providerName"], "Microsoft")
        self.assertTrue(claims["email"].endswith(".invalid"))
        access = jwt.decode(body["access_token"], self.client.app.config.jwt_secret, self.clock())
        self.assertEqual(access["token_use"], "access")
        self.assertEqual(access["exp"] - access["iat"], 10)
        # The API accepts it and creates the user from the claims.
        status, me = self.client.call("GET", "/v1/me", token=body["access_token"])
        self.assertEqual(status, 200)
        self.assertEqual(me["provider"], "microsoft")
        self.assertEqual(me["displayName"], "Maria")

    def test_each_provider_maps_to_user_provider(self):
        for idp, provider in (("Google", "google"), ("SignInWithApple", "apple"), ("Microsoft", "microsoft")):
            status, body = self.exchange(self.code(name=f"Tester {idp}", idp=idp))
            status, me = self.client.call("GET", "/v1/me", token=body["access_token"])
            self.assertEqual(me["provider"], provider)

    def test_wrong_verifier_is_refused(self):
        status, body = self.exchange(self.code(), verifier="x" * 43)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "invalid_grant")

    def test_code_is_single_use(self):
        code = self.code()
        self.assertEqual(self.exchange(code)[0], 200)
        status, body = self.exchange(code)
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "invalid_grant", "error_description": "Authorization code already used"})

    def test_redirect_uri_must_match(self):
        status, body = self.exchange(self.code(), redirect="http://localhost:5173/other")
        self.assertEqual((status, body["error"]), (400, "invalid_grant"))

    def test_client_must_match(self):
        status, body = self.exchange(self.code(), client="another-client")
        self.assertEqual((status, body["error"]), (400, "invalid_grant"))

    def test_code_expires(self):
        code = self.code()
        self.clock.advance(301)
        self.assertEqual(self.exchange(code)[1]["error"], "invalid_grant")

    def test_token_endpoint_wants_a_form(self):
        status, body = self.client.call("POST", "/oauth2/token", body={"grant_type": "authorization_code"})
        self.assertEqual((status, body["error"]), (400, "invalid_request"))
        status, body = self.client.call("POST", "/oauth2/token", form={"grant_type": "password", "client_id": CLIENT})
        self.assertEqual((status, body["error"]), (400, "unsupported_grant_type"))

    def test_expired_access_token_then_refresh(self):
        _, tokens = self.exchange(self.code())
        self.assertEqual(self.client.call("GET", "/v1/me", token=tokens["access_token"])[0], 200)
        self.clock.advance(11)  # --token-ttl 10
        status, body = self.client.call("GET", "/v1/me", token=tokens["access_token"])
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "token_expired")
        # Reading still needs no token, but a stale one is reported, not ignored.
        self.assertEqual(self.client.call("GET", "/v1/questions", token=tokens["access_token"])[0], 401)
        self.assertEqual(self.client.call("GET", "/v1/questions")[0], 200)
        status, fresh = self.client.call("POST", "/oauth2/token", form={
            "grant_type": "refresh_token", "client_id": CLIENT, "refresh_token": tokens["refresh_token"]})
        self.assertEqual(status, 200, fresh)
        self.assertEqual(set(fresh), {"access_token", "id_token", "token_type", "expires_in"})
        self.assertEqual(self.client.call("GET", "/v1/me", token=fresh["access_token"])[0], 200)

    def test_bad_refresh_token_and_revoke(self):
        _, tokens = self.exchange(self.code())
        status, body = self.client.call("POST", "/oauth2/token", form={
            "grant_type": "refresh_token", "client_id": CLIENT, "refresh_token": "nope"})
        self.assertEqual((status, body["error"]), (400, "invalid_grant"))
        status, _ = self.client.call("POST", "/oauth2/revoke", form={"token": tokens["refresh_token"], "client_id": CLIENT})
        self.assertEqual(status, 200)
        status, body = self.client.call("POST", "/oauth2/token", form={
            "grant_type": "refresh_token", "client_id": CLIENT, "refresh_token": tokens["refresh_token"]})
        self.assertEqual(body["error"], "invalid_grant")

    def test_forged_token_is_refused(self):
        _, tokens = self.exchange(self.code())
        header, claims, signature = tokens["access_token"].split(".")
        data = json.loads(base64.urlsafe_b64decode(claims + "=="))
        data["sub"] = "someone-else"
        forged = base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
        status, body = self.client.call("GET", "/v1/me", token=f"{header}.{forged}.{signature}")
        self.assertEqual((status, body["error"]["code"]), (401, "invalid_token"))
        none_alg = jwt.b64url(json.dumps({"alg": "none"}).encode())
        status, body = self.client.call("GET", "/v1/me", token=f"{none_alg}.{claims}.")
        self.assertEqual(status, 401)

    def test_logout_redirects(self):
        status, headers, _ = self.client.raw("GET", "/logout?client_id=c&logout_uri=http%3A%2F%2Flocalhost%3A8787%2F")
        self.assertEqual((status, headers["Location"]), (302, "http://localhost:8787/"))
        status, _, _ = self.client.raw("GET", "/logout?client_id=c&logout_uri=https%3A%2F%2Fevil.example%2F")
        self.assertEqual(status, 400)
        status, _, page = self.client.raw("GET", "/logout?client_id=c")
        self.assertEqual(status, 200)

    def test_same_name_same_user_as_seed(self):
        _, tokens = self.exchange(self.code(name="Anna", idp="Google"))
        _, me = self.client.call("GET", "/v1/me", token=tokens["access_token"])
        self.assertEqual(me["createdAt"], "2026-09-28T08:00:00.000Z")  # the seed author

    def test_patch_me(self):
        status, me = self.client.call("PATCH", "/v1/me", "elena", {"displayName": "  Elena  "})
        self.assertEqual((status, me["displayName"]), (200, "Elena"))
        status, body = self.client.call("PATCH", "/v1/me", "elena", {"displayName": "x" * 41})
        self.assertEqual((status, body["error"]["field"]), (400, "displayName"))
        status, body = self.client.call("PATCH", "/v1/me", "elena", {"displayName": ""})
        self.assertEqual(status, 400)
        # The new name shows on everything the user wrote.
        self.client.call("PATCH", "/v1/me", "anna", {"displayName": "Anna M."})
        _, full = self.client.call("GET", "/v1/questions/01JAS000000000000000000Q01")
        self.assertEqual(full["question"]["author"]["displayName"], "Anna M.")

    def test_openid_configuration(self):
        status, body = self.client.call("GET", "/.well-known/openid-configuration")
        self.assertEqual(status, 200)
        self.assertTrue(body["token_endpoint"].endswith("/oauth2/token"))


if __name__ == "__main__":
    unittest.main()
