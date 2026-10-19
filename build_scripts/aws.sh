#!/usr/bin/env bash
# Builds the server for Lambda (arm64) and deploys the stack server/aws/stack.yaml:
# the tables, the Lambda, the HTTP API on api.bible.marketkernel.com.
#
#   build_scripts/aws.sh                     build, upload, deploy, check /v1/health
#   AWS_PROFILE=… AWS_REGION=… build_scripts/aws.sh    another account or region
#
# Needs the AWS CLI (a profile allowed to deploy) and cargo-lambda, which
# cross-compiles with zig: `pip install cargo-lambda` brings both.
# The zip goes to the bucket html-bible-deploy-<account>, made here the first time;
# so is the key of invitation codes (SSM /html-bible/invite-key), which is never replaced.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE:-html-bible}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
STACK=html-bible-api
DOMAIN=api.bible.marketkernel.com

if ! command -v cargo-lambda >/dev/null 2>&1; then
  echo "cargo-lambda is needed: pip install cargo-lambda (it brings zig)" >&2
  exit 1
fi

(cd server && cargo lambda build --release --arm64 --bin lambda --no-default-features --features aws --output-format zip)
ZIP=server/target/lambda/lambda/bootstrap.zip

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="html-bible-deploy-$ACCOUNT"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=project,Value=html-bible}]'
  # Lambda keeps its own copy of the code: the uploads are needed only while deploying.
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"old-builds","Status":"Enabled","Filter":{"Prefix":"api/"},"Expiration":{"Days":30}}]}' >/dev/null
  echo "made the bucket $BUCKET"
fi
# The key of invitation codes: made once, never overwritten (a new key voids
# every code given out and not used yet). It goes through a file only its owner
# can read, removed at once: never on a command line or in the history.
PARAM=/html-bible/invite-key
if ! aws ssm get-parameter --name "$PARAM" >/dev/null 2>&1; then
  SECRET_FILE=$(umask 077 && mktemp)
  trap 'rm -f "$SECRET_FILE"' EXIT
  printf '{"Name":"%s","Type":"SecureString","Value":"%s","Description":"html-bible: the key of invitation codes"}' \
    "$PARAM" "$(openssl rand -base64 32)" > "$SECRET_FILE"
  aws ssm put-parameter --cli-input-json "file://$SECRET_FILE" >/dev/null
  rm -f "$SECRET_FILE"
  aws ssm add-tags-to-resource --resource-type Parameter --resource-id "$PARAM" --tags Key=project,Value=html-bible
  echo "made the invitation key $PARAM"
fi

KEY="api/$(date -u +%Y%m%dT%H%M%S)-$(shasum -a 256 "$ZIP" | cut -c1-12).zip"
aws s3 cp --only-show-errors "$ZIP" "s3://$BUCKET/$KEY"

aws cloudformation deploy --stack-name "$STACK" --template-file server/aws/stack.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --tags project=html-bible \
  --parameter-overrides "CodeBucket=$BUCKET" "CodeKey=$KEY" "DomainName=$DOMAIN"

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
echo
curl -fsS "https://$DOMAIN/v1/health" && echo
