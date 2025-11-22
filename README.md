# WaveStack

WaveStack is a cloud-native music streaming platform scaffold with a React frontend, NestJS GraphQL API, PostgreSQL, Neo4j, RabbitMQ, Python FastAPI audio service, .NET analytics service, Docker, Docker Compose, Caddy, and Azure VM deployment support.

## Local Development

Run this from the repository root:

```bash
cp .env.example .env
docker compose up --build
```

Open the local services:

```txt
Frontend:          http://localhost:5173
GraphQL API:       http://localhost:3000/graphql
Audio AI service:  http://localhost:8000/health
Analytics service: http://localhost:8080/health
RabbitMQ UI:       http://localhost:15672
Neo4j UI:          http://localhost:7474
```

Stop the local stack:

```bash
docker compose down
```

## Azure VM Deployment

Follow these steps in order from **1** to **17**.

This deployment uses one Azure VM running Docker Compose. It does not require AKS, Azure Database for PostgreSQL, Vercel, or GitHub Actions.

You need a domain or subdomain you control, such as:

```txt
REPLACE-ME-WITH-YOUR-DOMAIN
```

Examples:

```txt
wavestack.example.com
music.example.com
your-free-subdomain.example-dns-provider.com
```

You will point this domain and its `api` subdomain to the Azure VM public IP in step 8.

## 1. Install Azure CLI

```bash
curl -fsSL 'https://azurecliprod.blob.core.windows.net/$root/deb_install.sh' | sudo bash
```

## 2. Log in to Azure

```bash
az login
az account show
```

If Azure asks you to select a subscription, choose the subscription you want to use.

## 3. Set deployment variables

Replace every `REPLACE-ME` value before running this.

```bash
export RG="REPLACE-ME-WITH-AZURE-RESOURCE-GROUP"
export VM_NAME="REPLACE-ME-WITH-VM-NAME"
export ADMIN_USER="REPLACE-ME-WITH-VM-ADMIN-USERNAME"
export DOMAIN="REPLACE-ME-WITH-YOUR-DOMAIN"
```

Example values:

```bash
export RG="rg-wavestack-dev"
export VM_NAME="wavestack-dev-vm"
export ADMIN_USER="azureuser"
export DOMAIN="wavestack.example.com"
```

## 4. Create an SSH key

```bash
test -f ~/.ssh/wavestack_azure.pub || \
ssh-keygen -t ed25519 -f ~/.ssh/wavestack_azure -C "wavestack-azure-vm" -N ""

export VM_SSH_KEY="$(cat ~/.ssh/wavestack_azure.pub)"
```

## 5. Select a compatible Azure region, VM size, and Ubuntu image

This step automatically chooses a deployment region, VM size, CPU architecture, and matching Ubuntu image for the current Azure subscription.

```bash
export DEPLOYMENT_INFO="$(python3 - <<'PY'
import json
import subprocess
import sys

regions = [
    "southcentralus",
    "eastus2",
    "westus2",
    "westus",
    "centralus",
    "northcentralus",
    "westcentralus",
    "eastus"
]

preferred_skus = [
    "Standard_B2ps_v2",
    "Standard_B2pls_v2",
    "Standard_D2ps_v5",
    "Standard_D2pls_v5",
    "Standard_B2s",
    "Standard_B1s",
    "Standard_D2s_v6",
    "Standard_D2as_v6",
    "Standard_D2ads_v6"
]

def run(args):
    return subprocess.check_output(args, text=True).strip()

for region in regions:
    try:
        raw = run([
            "az", "vm", "list-skus",
            "--location", region,
            "--resource-type", "virtualMachines",
            "--all",
            "-o", "json"
        ])
        skus = json.loads(raw)
    except Exception:
        continue

    available = {}

    for sku in skus:
        name = sku.get("name")
        restrictions = sku.get("restrictions") or []

        if restrictions:
            continue

        caps = {
            capability["name"]: capability["value"]
            for capability in sku.get("capabilities", [])
        }

        available[name] = caps

    ordered = preferred_skus + sorted(available)

    for sku_name in ordered:
        if sku_name not in available:
            continue

        caps = available[sku_name]

        try:
            vcpus = int(float(caps.get("vCPUs", "999")))
        except ValueError:
            vcpus = 999

        if vcpus > 2:
            continue

        arch = caps.get("CpuArchitectureType", "x64")
        image_arch = "Arm64" if arch == "Arm64" else "x64"

        try:
            image = run([
                "az", "vm", "image", "list",
                "--location", region,
                "--publisher", "Canonical",
                "--offer", "0001-com-ubuntu-server-jammy",
                "--architecture", image_arch,
                "--all",
                "--query", "[?contains(sku, '22_04')]|[-1].urn",
                "-o", "tsv"
            ])
        except Exception:
            continue

        if image:
            print(f"{region}|{sku_name}|{arch}|{image}")
            sys.exit(0)

print(
    "No compatible Azure region, VM size, and Ubuntu image were found for this subscription.",
    file=sys.stderr
)
sys.exit(1)
PY
)"

export LOCATION="$(echo "$DEPLOYMENT_INFO" | cut -d'|' -f1)"
export VM_SIZE="$(echo "$DEPLOYMENT_INFO" | cut -d'|' -f2)"
export VM_ARCH="$(echo "$DEPLOYMENT_INFO" | cut -d'|' -f3)"
export VM_IMAGE="$(echo "$DEPLOYMENT_INFO" | cut -d'|' -f4-)"

echo "Selected Azure region: $LOCATION"
echo "Selected VM size: $VM_SIZE"
echo "Selected CPU architecture: $VM_ARCH"
echo "Selected Ubuntu image: $VM_IMAGE"
```

## 6. Create the Azure resource group

```bash
az group create \
  --name "$RG" \
  --location "$LOCATION"
```

## 7. Create the Azure VM

```bash
az vm create \
  --resource-group "$RG" \
  --name "$VM_NAME" \
  --location "$LOCATION" \
  --image "$VM_IMAGE" \
  --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" \
  --ssh-key-values "$VM_SSH_KEY" \
  --public-ip-sku Standard
```

## 8. Save the VM public IP

```bash
export VM_IP="$(az vm show \
  --resource-group "$RG" \
  --name "$VM_NAME" \
  --show-details \
  --query publicIps \
  -o tsv)"

echo "VM public IP: $VM_IP"
```

Create or update DNS records with your DNS provider:

```txt
A record:
REPLACE-ME-WITH-YOUR-DOMAIN -> VM public IP

A record:
api.REPLACE-ME-WITH-YOUR-DOMAIN -> VM public IP
```

Example:

```txt
wavestack.example.com     -> 203.0.113.10
api.wavestack.example.com -> 203.0.113.10
```

Wait until DNS resolves before continuing:

```bash
nslookup "$DOMAIN"
nslookup "api.$DOMAIN"
```

Both should return the VM public IP.

## 9. Open required Azure firewall ports

```bash
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 22 --priority 1000
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 80 --priority 1010
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 443 --priority 1020
```

## 10. Confirm SSH access

```bash
until ssh -o StrictHostKeyChecking=no -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "uname -m && echo SSH ready"; do
  echo "Waiting for SSH..."
  sleep 15
done
```

Expected output is either:

```txt
aarch64
SSH ready
```

or:

```txt
x86_64
SSH ready
```

## 11. Install Docker on the VM

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" 'set -e

sudo apt-get update
sudo apt-get install -y ca-certificates curl git rsync

sudo install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo tee /etc/apt/keyrings/docker.asc >/dev/null

sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
'
```

## 12. Upload the project to the VM

Run this from the repository root on your local machine:

```bash
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "build" \
  --exclude "coverage" \
  --exclude ".env" \
  --exclude "secrets" \
  --exclude "services/graphql-api/.cache" \
  -e "ssh -i ~/.ssh/wavestack_azure" \
  ./ "$ADMIN_USER@$VM_IP:/home/$ADMIN_USER/WaveStack/"
```

## 13. Create the remote environment file

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "set -e
cd ~/WaveStack
cp .env.example .env
"
```

## 14. Configure HTTPS routing with Caddy

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "set -e
cd ~/WaveStack

cat > Caddyfile <<EOF
$DOMAIN {
  reverse_proxy frontend:5173
}

api.$DOMAIN {
  reverse_proxy graphql-api:3000
}
EOF
"
```

## 15. Configure Docker Compose for the public HTTPS API URL

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "set -e
cd ~/WaveStack

python3 - <<PY
from pathlib import Path

domain = '$DOMAIN'
p = Path('docker-compose.yml')
s = p.read_text()

s = s.replace(
    'VITE_GRAPHQL_URL: http://localhost:3000/graphql',
    f'VITE_GRAPHQL_URL: https://api.{domain}/graphql'
)

s = s.replace(
    'VITE_GRAPHQL_URL: http://\${VM_PUBLIC_IP:-localhost}:3000/graphql',
    f'VITE_GRAPHQL_URL: https://api.{domain}/graphql'
)

if '  caddy:' not in s.split('\\nvolumes:\\n')[0]:
    caddy_service = '''
  caddy:
    image: caddy:2
    ports:
      - \"80:80\"
      - \"443:443\"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - frontend
      - graphql-api

'''
    s = s.replace('\\nvolumes:\\n', '\\n' + caddy_service + 'volumes:\\n')

if '  caddy-data:' not in s:
    s = s.replace(
        '  neo4j-data:\\n',
        '  neo4j-data:\\n  caddy-data:\\n  caddy-config:\\n'
    )

p.write_text(s)
PY
"
```

## 16. Build and start WaveStack

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "set -e
cd ~/WaveStack

sudo docker compose config >/dev/null
sudo docker compose down || true
sudo docker compose up --build -d
sudo docker compose ps
"
```

## 17. Open the deployed app

Open your frontend:

```txt
https://REPLACE-ME-WITH-YOUR-DOMAIN
```

Open your GraphQL API:

```txt
https://api.REPLACE-ME-WITH-YOUR-DOMAIN/graphql
```

WaveStack is now deployed on an Azure VM with HTTPS.

## Updating an Existing Deployment

After changing code locally, upload and restart the app:

```bash
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "build" \
  --exclude "coverage" \
  --exclude ".env" \
  --exclude "secrets" \
  --exclude "services/graphql-api/.cache" \
  -e "ssh -i ~/.ssh/wavestack_azure" \
  ./ "$ADMIN_USER@$VM_IP:/home/$ADMIN_USER/WaveStack/"

ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "set -e
cd ~/WaveStack
sudo docker compose up --build -d
sudo docker compose ps
"
```

## Useful Logs

```bash
ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "cd ~/WaveStack && sudo docker compose logs frontend --tail=100"

ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "cd ~/WaveStack && sudo docker compose logs graphql-api --tail=100"

ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "cd ~/WaveStack && sudo docker compose logs audio-ai-service --tail=100"

ssh -i ~/.ssh/wavestack_azure "$ADMIN_USER@$VM_IP" "cd ~/WaveStack && sudo docker compose logs analytics-service --tail=100"
```

## GitHub secrets

Go to:

```txt
/settings/secrets/actions/new
```

Add:

```txt
VM_HOST
VM_USER
VM_SSH_PRIVATE_KEY_B64
VM_SSH_PRIVATE_KEY
```

Use these values:

```bash
echo "$ADMIN_USER"
base64 -w 0 ~/.ssh/wavestack_azure
cat ~/.ssh/wavestack_azure
```

For `VM_HOST`, use only the IP or hostname.

Do not include:

```txt
https://
http://
a trailing slash
a URL path
```

## Private Google Drive JSON secret for listening-habit exports

WaveStack can export listening-habit JSON files to a private Google Drive folder.
This requires a Google **service account JSON key**. A normal Google Drive API key
cannot write to a private folder.

### 1. Create the service account JSON

In Google Cloud Console:

1. Go to **IAM & Admin**
2. Go to **Service Accounts**
3. Create a service account, for example:

```txt
wavestack-drive-writer
```

4. Open the service account
5. Go to **Keys**
6. Click **Add key**
7. Click **Create new key**
8. Choose **JSON**
9. Download the JSON file

Do not commit this JSON file to GitHub.

### 2. Share the private Drive folder with the service account

Open the private Google Drive folder where WaveStack should write exports.

Click **Share**, then add the service account email as **Editor**.

The service account email looks like this:

```txt
wavestack-drive-writer@YOUR_GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com
```

Copy the Drive folder ID from the folder URL.

Example URL:

```txt
https://drive.google.com/drive/folders/1YtWvgCd-wJqbIaFcpi6BAgco732vBFaE
```

Folder ID:

```txt
1YtWvgCd-wJqbIaFcpi6BAgco732vBFaE
```

### 3. Store the JSON locally

From your local WSL machine:

```bash
cd /home/projects/WaveStack

mkdir -p secrets

mv /mnt/c/Users/qacer/Downloads/YOUR_DOWNLOADED_SERVICE_ACCOUNT_FILE.json \
  secrets/google-drive-service-account.json

chmod 600 secrets/google-drive-service-account.json

ls -la secrets/google-drive-service-account.json
```

The file should now be here locally:

```txt
/home/projects/WaveStack/secrets/google-drive-service-account.json
```

### 4. Make sure the JSON is ignored by Git

Add this to `.gitignore`:

```gitignore
secrets/
google-drive-service-account.json
*service-account*.json
```

Never run:

```bash
git add secrets/google-drive-service-account.json
```

### 5. Add local environment variables

In local `.env`:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-drive-service-account.json
GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED=true
LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID=REPLACE-ME-WITH-PRIVATE-DRIVE-FOLDER-ID
```

Example:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-drive-service-account.json
GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED=true
LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID=1YtWvgCd-wJqbIaFcpi6BAgco732vBFaE
```

Use `/app/secrets/...` because the backend runs inside Docker.

Docker maps this host folder:

```txt
./secrets
```

to this container folder:

```txt
/app/secrets
```

### 6. Add example environment variables

In `.env.example`, add placeholders only:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-drive-service-account.json
GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED=false
LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID=TODO_FILL_LATER
```

Do not put real secrets in `.env.example`.

### 7. Mount the JSON into the GraphQL API container

In `docker-compose.yml`, under the `graphql-api` service, add these environment
variables:

```yaml
      GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-/app/secrets/google-drive-service-account.json}
      GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED: ${GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED:-false}
      LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID: ${LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID:-TODO_FILL_LATER}
```

Also add this volume under the same `graphql-api` service:

```yaml
    volumes:
      - ./secrets:/app/secrets:ro
```

The `graphql-api` service should include this shape:

```yaml
  graphql-api:
    build:
      context: ./services/graphql-api
    ports:
      - "3000:3000"
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: wavestack
      POSTGRES_USER: wavestack
      POSTGRES_PASSWORD: wavestack_dev_password
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: wavestack_graph_password
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      AUDIO_SERVICE_URL: http://audio-ai-service:8000
      ANALYTICS_SERVICE_URL: http://analytics-service:8080
      SIGNED_URL_SECRET: local-dev-secret
      GOOGLE_DRIVE_API_KEY: ${GOOGLE_DRIVE_API_KEY}
      GOOGLE_DRIVE_FOLDER_IDS: ${GOOGLE_DRIVE_FOLDER_IDS}
      API_PUBLIC_ORIGIN: ${API_PUBLIC_ORIGIN:-http://localhost:3000}
      JWT_SECRET: ${JWT_SECRET:-replace-with-real-jwt-secret-in-production}
      LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID: ${LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID:-TODO_FILL_LATER}
      GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-/app/secrets/google-drive-service-account.json}
      GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED: ${GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED:-false}
    volumes:
      - ./secrets:/app/secrets:ro
    depends_on:
      - postgres
      - neo4j
      - rabbitmq
      - audio-ai-service
      - analytics-service
```

### 8. Copy the JSON secret to the Azure VM

From your local WSL machine, use the real VM IP and SSH key.

Example:

```bash
cd /home/projects/WaveStack

scp -i ~/.ssh/wavestack_azure \
  secrets/google-drive-service-account.json \
  azureuser@20.225.235.88:/home/azureuser/google-drive-service-account.json
```

Then SSH into the VM:

```bash
ssh -i ~/.ssh/wavestack_azure azureuser@20.225.235.88
```

On the VM:

```bash
cd ~/WaveStack

mkdir -p secrets

mv /home/azureuser/google-drive-service-account.json \
  secrets/google-drive-service-account.json

chmod 600 secrets/google-drive-service-account.json

ls -la secrets/google-drive-service-account.json
```

The file should now be here on the VM:

```txt
/home/azureuser/WaveStack/secrets/google-drive-service-account.json
```

### 9. Configure the VM `.env`

On the VM:

```bash
cd ~/WaveStack
nano .env
```

Add or update:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-drive-service-account.json
GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED=true
LISTENING_HABITS_GOOGLE_DRIVE_FOLDER_ID=REPLACE-ME-WITH-PRIVATE-DRIVE-FOLDER-ID
```

Save with:

```txt
Ctrl + O
Enter
Ctrl + X
```

### 10. Rebuild the API container

On the VM:

```bash
cd ~/WaveStack

docker compose up -d --build graphql-api
```

If Docker permission fails, run the same command with `sudo`:

```bash
sudo docker compose up -d --build graphql-api
```

### 11. Verify Docker can see the JSON

On the VM:

```bash
cd ~/WaveStack

docker compose exec graphql-api ls -la /app/secrets

docker compose exec graphql-api printenv GOOGLE_APPLICATION_CREDENTIALS

docker compose exec graphql-api printenv GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED
```

Expected:

```txt
/app/secrets/google-drive-service-account.json
true
```

If using `sudo`:

```bash
sudo docker compose exec graphql-api ls -la /app/secrets

sudo docker compose exec graphql-api printenv GOOGLE_APPLICATION_CREDENTIALS

sudo docker compose exec graphql-api printenv GOOGLE_DRIVE_PRIVATE_EXPORT_ENABLED
```

### 12. Add Docker permission for the VM user

If `docker compose` requires `sudo`, add the VM user to the Docker group:

```bash
sudo usermod -aG docker azureuser
```

Then log out:

```bash
exit
```

SSH back in:

```bash
ssh -i ~/.ssh/wavestack_azure azureuser@20.225.235.88
```

Test:

```bash
docker ps
```

If `docker ps` works without `sudo`, Docker permissions are fixed.

### 13. Make sure deploys do not delete the secret

Your deployment uses `rsync --delete`. Keep these exclusions so deploys do not
delete `.env` or `secrets/` on the VM:

```bash
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "build" \
  --exclude "coverage" \
  --exclude ".env" \
  --exclude "secrets" \
  --exclude "services/graphql-api/.cache" \
  -e "ssh -i ~/.ssh/wavestack_azure" \
  ./ "$ADMIN_USER@$VM_IP:/home/$ADMIN_USER/WaveStack/"
```

### 14. Test the private Drive write mutation

After the backend code includes the private Drive export resolver, test:

```bash
cd ~/WaveStack

curl -s http://localhost:3000/graphql \
  -H "content-type: application/json" \
  --data '{"query":"mutation { testPrivateDriveWrite { ok message folderId credentialsPath fileId webViewLink } }"}' \
  | python3 -m json.tool
```

If the mutation is installed correctly and the Drive folder was shared with the
service account, the response should include:

```json
{
  "ok": true
}
```

Then check the private Google Drive folder for a new test JSON file.

If the response says:

```txt
Cannot query field "testPrivateDriveWrite" on type "Mutation"
```

then the JSON secret is mounted correctly, but the backend code for the mutation
has not been added, committed, pushed, pulled onto the VM, or imported into
`AppModule` yet.

Check on the VM:

```bash
cd ~/WaveStack

grep -R "testPrivateDriveWrite" -n services/graphql-api/src || echo "MISSING testPrivateDriveWrite"
grep -R "DrivePrivateExportService" -n services/graphql-api/src || echo "MISSING DrivePrivateExportService"
grep -R "HabitsModule" -n services/graphql-api/src/app.module.ts || echo "MISSING HabitsModule in AppModule"
```

If those are missing, apply the backend code changes locally, commit, push, pull
on the VM, and rebuild the API container.

## Login VM
ssh -i ~/.ssh/wavestack_azure azureuser@[IP]

## Cleanup

Delete the Azure resource group when you no longer need the deployment:

```bash
az group delete \
  --name "$RG" \
  --yes \
  --no-wait
```
