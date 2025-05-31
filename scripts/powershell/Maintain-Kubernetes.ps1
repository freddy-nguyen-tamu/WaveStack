param(
    [ValidateSet("status", "restart", "logs")]
    [string]$Action = "status",

    [string]$Namespace = "wavestack",

    [string]$Deployment = "graphql-api"
)

$ErrorActionPreference = "Stop"

switch ($Action) {
    "status" {
        kubectl get pods,svc,ingress -n $Namespace
    }
    "restart" {
        kubectl rollout restart deployment/$Deployment -n $Namespace
        kubectl rollout status deployment/$Deployment -n $Namespace
    }
    "logs" {
        kubectl logs deployment/$Deployment -n $Namespace --tail=200
    }
}
