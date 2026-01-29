#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project)}
REGION=${REGION:-us-central1}
SERVICE_NAME=${SERVICE_NAME:-polyphony-live}
REDIS_SIZE=${REDIS_SIZE:-5}

echo -e "${GREEN}=== Polyphony.live GCP Setup ===${NC}"
echo "Project ID: $PROJECT_ID"
echo "Region: $REGION"
echo "Service Name: $SERVICE_NAME"
echo ""

# Check if project is set
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID is not set${NC}"
    echo "Run: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

# Get project number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
echo -e "${GREEN}Project Number: $PROJECT_NUMBER${NC}"

# Step 1: Enable APIs
echo -e "\n${YELLOW}Step 1: Enabling required APIs...${NC}"
gcloud services enable run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    redis.googleapis.com \
    cloudbuild.googleapis.com \
    vpcaccess.googleapis.com \
    servicenetworking.googleapis.com \
    cloudresourcemanager.googleapis.com

echo -e "${GREEN}✓ APIs enabled${NC}"

# Step 2: Create Artifact Registry repository
echo -e "\n${YELLOW}Step 2: Creating Artifact Registry repository...${NC}"
if gcloud artifacts repositories describe $SERVICE_NAME --location=$REGION &>/dev/null; then
    echo -e "${YELLOW}Repository already exists${NC}"
else
    gcloud artifacts repositories create $SERVICE_NAME \
        --repository-format=docker \
        --location=$REGION \
        --description="Polyphony.live container images"
    echo -e "${GREEN}✓ Repository created${NC}"
fi

# Configure Docker authentication
echo -e "\n${YELLOW}Configuring Docker authentication...${NC}"
gcloud auth configure-docker $REGION-docker.pkg.dev --quiet

# Step 3: Create Redis instance
echo -e "\n${YELLOW}Step 3: Creating Memorystore Redis instance...${NC}"
if gcloud redis instances describe $SERVICE_NAME-redis --region=$REGION &>/dev/null; then
    echo -e "${YELLOW}Redis instance already exists${NC}"
else
    echo "Creating Redis instance (this may take 5-10 minutes)..."
    gcloud redis instances create $SERVICE_NAME-redis \
        --size=$REDIS_SIZE \
        --region=$REGION \
        --redis-version=redis_7_0 \
        --network=default \
        --connect-mode=DIRECT_PEERING \
        --async
    
    echo -e "${YELLOW}Redis instance creation started in background${NC}"
    echo -e "${YELLOW}Check status with: gcloud redis instances describe $SERVICE_NAME-redis --region=$REGION${NC}"
fi

# Step 4: Create VPC connector
echo -e "\n${YELLOW}Step 4: Creating Serverless VPC Access connector...${NC}"
if gcloud compute networks vpc-access connectors describe $SERVICE_NAME-connector --region=$REGION &>/dev/null; then
    echo -e "${YELLOW}VPC connector already exists${NC}"
else
    gcloud compute networks vpc-access connectors create $SERVICE_NAME-connector \
        --region=$REGION \
        --range=10.8.0.0/28 \
        --network=default
    echo -e "${GREEN}✓ VPC connector created${NC}"
fi

# Step 5: Setup Secrets
echo -e "\n${YELLOW}Step 5: Setting up Secret Manager...${NC}"

# Check if secret exists
if gcloud secrets describe google-ai-api-key &>/dev/null; then
    echo -e "${YELLOW}Secret 'google-ai-api-key' already exists${NC}"
else
    echo -e "${YELLOW}Creating secret for Google AI API Key...${NC}"
    echo -n "placeholder" | gcloud secrets create google-ai-api-key \
        --data-file=- \
        --replication-policy=user-managed \
        --locations=$REGION
    echo -e "${GREEN}✓ Secret created${NC}"
    echo -e "${YELLOW}IMPORTANT: Update the secret with your actual API key:${NC}"
    echo -e "echo -n 'your-api-key' | gcloud secrets versions add google-ai-api-key --data-file=-"
fi

# Grant access to default service account
echo -e "\n${YELLOW}Granting secret access to service account...${NC}"
gcloud secrets add-iam-policy-binding google-ai-api-key \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None 2>/dev/null || echo -e "${YELLOW}Policy already exists${NC}"

# Step 6: Summary
echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "1. Wait for Redis instance to be ready:"
echo "   gcloud redis instances describe $SERVICE_NAME-redis --region=$REGION --format='value(state)'"
echo ""
echo "2. Get your Redis IP address:"
echo "   export REDIS_IP=\$(gcloud redis instances describe $SERVICE_NAME-redis --region=$REGION --format='value(host)')"
echo ""
echo "3. Update the Google AI API Key secret:"
echo "   echo -n 'your-gemini-api-key' | gcloud secrets versions add google-ai-api-key --data-file=-"
echo ""
echo "4. Deploy the application:"
echo "   gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=$REGION,_REDIS_HOST=\$REDIS_IP"
echo ""
echo -e "${GREEN}Done!${NC}"
