locals {
  fqdn   = "${var.subdomain}.${var.domain}"
  labels = { project = "resilience-playground" }
}

resource "hcloud_ssh_key" "admin" {
  name       = var.server_name
  public_key = var.ssh_public_key
  labels     = local.labels
}

data "cloudflare_ip_ranges" "cf" {}

# SSH only from the owner, web ports only from Cloudflare, so the origin is not
# reachable directly and CF-Connecting-IP can be trusted. 6443 stays closed.
resource "hcloud_firewall" "server" {
  name   = var.server_name
  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
    description = "SSH from the owner"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = concat(data.cloudflare_ip_ranges.cf.ipv4_cidrs, data.cloudflare_ip_ranges.cf.ipv6_cidrs)
    description = "HTTP from Cloudflare"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = concat(data.cloudflare_ip_ranges.cf.ipv4_cidrs, data.cloudflare_ip_ranges.cf.ipv6_cidrs)
    description = "HTTPS from Cloudflare"
  }

  rule {
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Ping"
  }
}

resource "hcloud_server" "server" {
  name         = var.server_name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.server.id]
  labels       = local.labels

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }
}

resource "cloudflare_dns_record" "a" {
  zone_id = var.cloudflare_zone_id
  name    = local.fqdn
  type    = "A"
  content = hcloud_server.server.ipv4_address
  proxied = true
  ttl     = 1
  comment = "resilience-playground"
}

resource "cloudflare_dns_record" "aaaa" {
  zone_id = var.cloudflare_zone_id
  name    = local.fqdn
  type    = "AAAA"
  content = hcloud_server.server.ipv6_address
  proxied = true
  ttl     = 1
  comment = "resilience-playground"
}
