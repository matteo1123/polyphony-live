# Deploy Polyphony on Google Cloud Run (Free Tier)

## Prerequisites

- Google Cloud account (free tier works)
- gcloud CLI installed
- Docker installed

## Step 1: Set Up Google Cloud Project

```bash
# Login to Google Cloud
gcloud auth login

# Create project (or use existing)
gcloud projects create polyphony-demo --name="Polyphony Demo"
gcloud config set project polyphony-demo

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

## Step 2: Set Up Convex (Free Tier)

1. Go to https://convex.dev
2. Sign up with Google account
3. Create new project
4. Copy the deployment URL (looks like: `https://happy-parrot-123.convex.cloud`)
5. Save it for later

## Step 3: Set Up Secrets

```bash
# Create secrets in Google Cloud Secret Manager

# 1. Convex URL
echo -n "https://happy-parrot-123.convex.cloud" | gcloud secrets create convex-url --data-file=-

# 2. Google AI API Key
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create google-ai-key --data-file=-
```

**Get Gemini API Key:**
1. Go to https://makersuite.google.com/app/apikey
2. Create new API key
3. Copy and use above

## Step 4: Build and Deploy

```bash
# Build the Docker image
gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/polyphony-live:latest

# Update service.yaml with your project ID
sed -i '' "s/PROJECT_ID/$(gcloud config get-value project)/g" service-free-tier.yaml

# Deploy to Cloud Run
gcloud run services replace service-free-tier.yaml

# Get the URL
gcloud run services describe polyphony-live --format 'value(status.url)'
```

## Step 5: Verify Deployment

```bash
# Check service is running
gcloud run services describe polyphony-live

# Test health endpoint
curl https://YOUR-URL.run.app/health

# Should return:
# {"status":"healthy","activeMeetings":0}
```

## Configuration Details

### Free Tier Limits

| Resource | Limit | Our Usage |
|----------|-------|-----------|
| **CPU** | 180,000 vCPU-seconds/month | ~20,000 (11%) |
| **Memory** | 360,000 GB-seconds/month | ~40,000 (11%) |
| **Requests** | 2 million/month | ~10,000 (0.5%) |
| **Concurrent** | 80 connections | We use 100 (container) |

**Total cost: $0/month**

### What's Deployed

- **1 GCR instance** with 512MB RAM
- **Internal Redis** (no separate service)
- **Convex** free tier for persistence
- **Gemini API** free tier for AI

### Scaling Behavior

- **0 users** → Instance stops (scale to 0), $0 cost
- **1 user joins** → Cold start (~5s), instance starts
- **10 concurrent** → Single instance handles all
- **>100 connections** → Some may queue (rare in demo)

## Demo Day Checklist

Before showing to potential employers:

- [ ] Deploy latest code
- [ ] Test file upload (10MB limit)
- [ ] Test conflict detection
- [ ] Test grounded responses
- [ ] Test mermaid diagrams
- [ ] Check `/health` endpoint
- [ ] Have 2-3 demo documents ready
- [ ] Practice the script (3-5 minutes)

## Demo Script

### Opening (30 seconds)
> "This is Polyphony - an AI-powered document synthesis platform. 
> It doesn't just store documents, it **understands** them and finds connections."

### The Setup (1 minute)
1. Create new space
2. Upload "Product-Requirements.pdf" (PM doc)
3. Upload "Technical-Constraints.pdf" (Dev doc)

### The Wow (2 minutes)
1. **Ask:** "What are the conflicts between PM and dev priorities?"
   - Watch the response cite specific requirement IDs
   - See the canvas populate with conflict nodes
   
2. **Ask:** "Show me a timeline diagram"
   - Auto-generated Mermaid diagram appears
   - Shows PM deadline vs realistic dev estimate

3. **Upload third document** (Budget analysis)
   - Watch canvas auto-refresh
   - New budget conflict appears

### The Close (30 seconds)
> "Built with Gemini 2.0 Flash, LangGraph, and Convex. 
> It turns static documents into actionable intelligence."

## Troubleshooting

### Cold Start Too Slow
If 5-second cold start is noticeable:
```bash
# Change minScale to 1 (costs ~$5/month)
gcloud run services update polyphony-live --min-instances=1
```

### Redis Out of Memory
With 512MB, you can handle ~50 average meetings. If you hit limits:
1. Restart the service (clears Redis)
2. Or reduce to 5 concurrent max
3. Or upgrade to 1GB (still mostly free)

### API Rate Limits
Gemini free tier: 60 requests/minute
- If hitting limits, add delays between requests
- Or upgrade to paid ($0.0001 per 1K tokens, very cheap)

## Monitoring

```bash
# View logs
gcloud logging tail "resource.type=cloud_run_revision AND resource.labels.service_name=polyphony-live"

# View metrics
gcloud monitoring dashboards create --config-from-file=dashboard.json
```

## Updating Deployment

```bash
# After code changes
gcloud builds submit --tag gcr.io/$(gcloud config get-value project)/polyphony-live:latest
gcloud run services update-traffic polyphony-live --to-latest
```

## Cost Monitoring

```bash
# Check current month's usage
gcloud billing projects get-iam-policy $(gcloud config get-value project)

# Should show $0 or very low cost
```

## Next Steps (When You Get Funding)

1. **Upgrade to 1GB RAM** ($0 when under limits, ~$5 if always-on)
2. **Add external Redis** (Memorystore, $35/month) for scale
3. **Multiple GCR instances** with load balancer
4. **Custom domain** (polyphony.yourdomain.com)

## Support

- **Issues:** Check logs with `gcloud logging tail`
- **Health:** Test `/health` endpoint
- **Costs:** Monitor at https://console.cloud.google.com/billing
