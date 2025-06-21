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

## Cleanup

Delete the Azure resource group when you no longer need the deployment:

```bash
az group delete \
  --name "$RG" \
  --yes \
  --no-wait
```
