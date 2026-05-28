# Rentvine → Quo Contact Sync

Syncs all contacts (Owners, Tenants, Vendors, Associations) from Rentvine into Quo.
Runs as a **Google Cloud Run Job** triggered nightly by **Cloud Scheduler**.

---

## One-time Setup

### 1. Create GitHub repo
Push this folder to a new repo in your AloePM GitHub org, e.g. `AloePM/rentvine-quo-sync`.

### 2. Store secrets in Google Secret Manager
Run these commands in Google Cloud Shell (replace values with your real credentials):

```bash
# Set your project
gcloud config set project YOUR_PROJECT_ID

# Create secrets
echo -n "1de74b8e285a423692eb458978a24e9f" | \
  gcloud secrets create RENTVINE_KEY --data-file=-

echo -n "7a67efef12124bbab7fb4f80cbe5af38" | \
  gcloud secrets create RENTVINE_SECRET --data-file=-

echo -n "37c3cd6aca137586ad67d28f9db9ff68aec2456694feef9ffc286c3863716046" | \
  gcloud secrets create QUO_API_KEY --data-file=-
```

### 3. Create Artifact Registry repository (if not already exists)
```bash
gcloud artifacts repositories create aloe-pm \
  --repository-format=docker \
  --location=us-central1
```

### 4. Connect Cloud Build to GitHub
- Go to **Cloud Build → Triggers → Connect Repository**
- Connect your GitHub account and select `AloePM/rentvine-quo-sync`
- Create a trigger: Branch = `main`, Config = `cloudbuild.yaml`

### 5. Create the Cloud Run Job
```bash
gcloud run jobs create rentvine-quo-sync \
  --image=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/aloe-pm/rentvine-quo-sync:latest \
  --region=us-central1 \
  --set-secrets=RENTVINE_KEY=RENTVINE_KEY:latest,RENTVINE_SECRET=RENTVINE_SECRET:latest,QUO_API_KEY=QUO_API_KEY:latest \
  --max-retries=1 \
  --task-timeout=3600
```

### 6. Schedule it to run nightly
```bash
gcloud scheduler jobs create http rentvine-quo-sync-nightly \
  --location=us-central1 \
  --schedule="0 2 * * *" \
  --uri="https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/YOUR_PROJECT_ID/jobs/rentvine-quo-sync:run" \
  --message-body="{}" \
  --oauth-service-account-email=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

---

## Deploy
Push to `main` — Cloud Build automatically builds, pushes, and updates the job.

## Run manually
```bash
gcloud run jobs execute rentvine-quo-sync --region=us-central1
```

## View logs
```bash
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=rentvine-quo-sync" --limit=50
```
