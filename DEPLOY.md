# Deploy to Google Cloud Run

This guide walks you through deploying Polyphony.live to Google Cloud Run.

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A Google Cloud project with billing enabled
- Docker installed (for local testing)

## Architecture on GCP

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Cloud Run     │◄────┤  Memorystore     │     │  Secret Manager │
│  (Node.js app)  │     │  (Redis)         │     │  (API Keys)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Cloud Load     │
│  Balancing      │
│  (WebSocket)    │
└─────────────────┘
```

## Quick Deploy

### 1. Set Environment Variables

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
export SERVICE_NAME=polyphony-live
```

### 2. Run the Setup Script

```bash
chmod +x scripts/setup-gcp.sh
./scripts/setup-gcp.sh
```

### 3. Deploy via Cloud Build

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_REDIS_HOST=YOUR_REDIS_IP
```

## Manual Setup

### Step 1: Enable APIs

```bash
gcloud services enable run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    redis.googleapis.com \
    cloudbuild.googleapis.com \
    vpcaccess.googleapis.com \
    servicenetworking.googleapis.com
```

### Step 2: Create Artifact Registry Repository

```bash
gcloud artifacts repositories create $SERVICE_NAME \
    --repository-format=docker \
    --location=$REGION \
    --description="Polyphony.live container images"
```

### Step 3: Setup Redis (Memorystore)

```bash
# Create a Redis instance
gcloud redis instances create $SERVICE_NAME-redis \
    --size=5 \
    --region=$REGION \
    --redis-version=redis_7_0 \
    --network=default \
    --connect-mode=DIRECT_PEERING

# Get the Redis IP (takes a few minutes)
gcloud redis instances describe $SERVICE_NAME-redis \
    --region=$REGION \
    --format='value(host)'
```

**Note:** For Cloud Run to connect to Memorystore, you need to use [Serverless VPC Access](https://cloud.google.com/vpc/docs/serverless-vpc-access).

```bash
# Create a VPC connector
gcloud compute networks vpc-access connectors create $SERVICE_NAME-connector \
    --region=$REGION \
    --range=10.8.0.0/28 \
    --network=default
```

### Step 4: Store Secrets

```bash
# Create secret for Google AI API Key
echo -n "your-gemini-api-key" | gcloud secrets create google-ai-api-key \
    --data-file=- \
    --replication-policy=user-managed \
    --locations=$REGION

# Grant access to the default service account
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding google-ai-api-key \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### Step 5: Deploy

#### Option A: Cloud Build (Recommended)

```bash
# Update cloudbuild.yaml with your Redis IP, then:
gcloud builds submit --config cloudbuild.yaml \
    --substitutions=_REGION=$REGION,_REDIS_HOST=10.0.0.3
```

#### Option B: Manual gcloud

```bash
# Build and push
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/$SERVICE_NAME/$SERVICE_NAME

# Deploy
gcloud run deploy $SERVICE_NAME \
    --image $REGION-docker.pkg.dev/$PROJECT_ID/$SERVICE_NAME/$SERVICE_NAME \
    --region $REGION \
    --platform managed \
    --allow-unauthenticated \
    --set-env-vars "NODE_ENV=production,REDIS_HOST=YOUR_REDIS_IP,REDIS_PORT=6379,CORS_ORIGIN=*" \
    --set-secrets "GOOGLE_AI_API_KEY=google-ai-api-key:latest" \
    --vpc-connector $SERVICE_NAME-connector \
    --memory 1Gi \
    --cpu 1 \
    --concurrency 1000 \
    --max-instances 10 \
    --min-instances 1 \
    --timeout 300
```

## Important Considerations

### WebSocket Support

Cloud Run **does** support WebSockets with these requirements:

1. **Minimum instances >= 1**: WebSocket connections are stateful and require always-on instances
   ```bash
   --min-instances 1
   ```

2. **CPU always allocated**: Required for background processing
   ```bash
   --cpu-boost
   # or in service.yaml: run.googleapis.com/cpu-throttling: "false"
   ```

3. **Session affinity**: Not required for Socket.io (it handles reconnections)

### Redis Connection

Since Cloud Run containers are ephemeral, Redis is essential for:
- Storing room state
- Managing active users
- Sharing state between instances

### Scaling Behavior

- **Scale up**: When concurrent connections exceed current capacity
- **Scale down**: To `--min-instances` (should be >= 1 for WebSocket)
- **Idle timeout**: 300 seconds (configurable)

### Cost Optimization

```bash
# Development (scale to zero)
--min-instances 0 --max-instances 1

# Production (always-on for WebSocket)
--min-instances 2 --max-instances 10
```

## Monitoring

```bash
# View logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME" --limit=50

# Stream logs
gcloud alpha logging tail "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME"
```

## Troubleshooting

### Connection Refused to Redis

Ensure:
1. VPC connector is created and attached
2. Redis instance is in the same region
3. Firewall rules allow connection on port 6379

### WebSocket Disconnections

Check:
1. `--min-instances` is set to at least 1
2. CPU throttling is disabled
3. No aggressive timeouts in your Socket.io config

### Build Failures

```bash
# Check build logs
gcloud builds list
gcloud builds log BUILD_ID
```

## Cleanup

```bash
# Delete Cloud Run service
gcloud run services delete $SERVICE_NAME --region=$REGION

# Delete Redis instance
gcloud redis instances delete $SERVICE_NAME-redis --region=$REGION

# Delete VPC connector
gcloud compute networks vpc-access connectors delete $SERVICE_NAME-connector --region=$REGION

# Delete secrets
gcloud secrets delete google-ai-api-key
```
