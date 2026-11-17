output "ipv4" {
  description = "Public IPv4 address of the server."
  value       = hcloud_server.server.ipv4_address
}

output "ipv6" {
  description = "Public IPv6 address of the server."
  value       = hcloud_server.server.ipv6_address
}

output "fqdn" {
  description = "Public host name of the site."
  value       = local.fqdn
}

output "ssh_command" {
  description = "How to log in once Ansible has created the deploy user."
  value       = "ssh deploy@${hcloud_server.server.ipv4_address}"
}

output "server_type" {
  value = hcloud_server.server.server_type
}

output "location" {
  value = hcloud_server.server.location
}
