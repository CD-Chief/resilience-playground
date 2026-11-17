variable "hcloud_token" {
  description = "Hetzner Cloud API token. Set through TF_VAR_hcloud_token (the wrapper reads HCLOUD_TOKEN)."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit on the zone. Set through TF_VAR_cloudflare_api_token (the wrapper reads CLOUDFLARE_API_TOKEN)."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the domain (Overview page, API section)."
  type        = string
}

variable "domain" {
  description = "Zone apex the site lives under."
  type        = string
  default     = "chiefosei.dev"
}

variable "subdomain" {
  description = "Host name under the domain."
  type        = string
  default     = "lab"
}

variable "server_name" {
  description = "Name of the Hetzner server."
  type        = string
  default     = "resilience-playground"
}

variable "server_type" {
  description = "Hetzner server type. Check availability and price in the Hetzner console for your location; cpx22 is the alternative if cx23 is not offered."
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner location."
  type        = string
  default     = "nbg1"
}

variable "image" {
  description = "Server OS image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_public_key" {
  description = "The text of the public key that may log in (for example the contents of ~/.ssh/id_ed25519.pub)."
  type        = string
}

variable "admin_cidrs" {
  description = "CIDRs allowed to reach SSH (port 22). Use your own address as a /32."
  type        = list(string)

  validation {
    condition     = alltrue([for c in var.admin_cidrs : can(cidrhost(c, 0))])
    error_message = "Every admin_cidrs entry must be a valid CIDR, for example 203.0.113.7/32."
  }

  validation {
    condition     = !contains(var.admin_cidrs, "0.0.0.0/0") && !contains(var.admin_cidrs, "::/0")
    error_message = "admin_cidrs must not open SSH to the whole internet (0.0.0.0/0 or ::/0)."
  }
}
