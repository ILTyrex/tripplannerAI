#!/usr/bin/env bash
# Publica el frontend en S3 + CloudFront.
# 1) Genera frontend/js/config.js con los outputs del stack SAM y el ARN del Orchestrator.
# 2) Sincroniza frontend/ con el bucket privado (servido por CloudFront con OAC).
# 3) Invalida la caché de CloudFront.
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK:-tripplanner-backend}"
REGION="${AWS_REGION:-us-east-2}"
TARGET="${AGENTCORE_TARGET:-final}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

API_URL=$(out ApiUrl)
POOL_ID=$(out UserPoolId)
CLIENT_ID=$(out UserPoolClientId)
BUCKET=$(out FrontendBucketName)
DIST_ID=$(out DistributionId)
FRONT_URL=$(out FrontendUrl)
AGENT_ARN=$(node -e "const s=require('./agentcore/.cli/deployed-state.json');console.log(s.targets['$TARGET'].resources.runtimes.OrchestratorAgent.runtimeArn)")

cat > frontend/js/config.js <<EOF
// Generado por scripts/deploy_frontend.sh a partir de los outputs de CloudFormation/AgentCore.
// No contiene secretos: solo identificadores públicos (el acceso se protege con JWT de Cognito).
window.TRIPPLANNER_CONFIG = {
  "region": "$REGION",
  "apiUrl": "$API_URL",
  "userPoolId": "$POOL_ID",
  "userPoolClientId": "$CLIENT_ID",
  "agentRuntimeArn": "$AGENT_ARN"
};
EOF

aws s3 sync frontend/ "s3://$BUCKET/" --delete --region "$REGION" \
  --exclude "*" --include "*.html" --include "*.css" --include "*.js" --include "*.svg" --include "*.png" \
  --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query "Invalidation.Id" --output text

echo "Frontend publicado en $FRONT_URL"
