"""Every request/response pair in tests/fixtures/api must hold against the stub."""

from __future__ import annotations

import unittest

from server.core.app import set_app
from server.tests import contract


class ContractTest(unittest.TestCase):
    def test_fixtures_exist(self):
        self.assertGreaterEqual(len(contract.load_fixtures()), 30)

    def test_fixtures(self):
        for name, fixture in contract.load_fixtures().items():
            with self.subTest(fixture=name):
                self.assertTrue(fixture["steps"], "a fixture needs steps")
                problems = contract.check_fixture(fixture)
                self.assertEqual(problems, [], "\n".join(problems[:20]))
        set_app(None)

    def test_compare_is_strict(self):
        self.assertEqual(contract.compare({"a": 1}, {"a": 1}), [])
        self.assertTrue(contract.compare({"a": 1}, {"a": 1, "b": 2}))  # extra keys are contract drift
        self.assertTrue(contract.compare({"a": 1}, {"a": 1.0}))
        self.assertTrue(contract.compare({"a": 1}, {"a": True}))
        self.assertEqual(contract.compare("<ulid>", "01JAS000000000000000000Q01"), [])
        self.assertTrue(contract.compare("<ulid>", "not-an-id"))
        self.assertEqual(contract.compare("<iso8601>", "2026-10-18T12:00:00.000Z"), [])


if __name__ == "__main__":
    unittest.main()
