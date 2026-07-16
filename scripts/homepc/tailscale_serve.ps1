<#
Meeting Master — publish the job server on the tailnet over HTTPS.

Maps https://<machine-name>.<tailnet>.ts.net -> 127.0.0.1:8080 with a
Tailscale-provisioned certificate. The printed URL is what goes into
HOME_SERVER_URL in the laptop's laptop.env.

NOTE: the serve configuration is PERSISTENT — Tailscale runs as a Windows
service and re-applies it after every reboot. You only need to run this
script once, and again only after a `tailscale serve reset` (or on a fresh
Tailscale install). It is safe to re-run at any time.
#>

$ErrorActionPreference = 'Stop'

tailscale serve --bg 8080
if ($LASTEXITCODE -ne 0) { throw 'tailscale serve failed — is Tailscale installed and signed in?' }

# Show the resulting mapping, including the public-to-this-tailnet HTTPS URL.
tailscale serve status
