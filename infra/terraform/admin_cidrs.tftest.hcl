# Offline checks of the admin_cidrs validation. Mock providers: nothing is created.
mock_provider "hcloud" {}
mock_provider "cloudflare" {}

variables {
  hcloud_token         = "x"
  cloudflare_api_token = "x"
  cloudflare_zone_id   = "x"
  ssh_public_key       = "ssh-ed25519 AAAA test"
}

run "accepts_a_host_cidr" {
  command = plan
  variables { admin_cidrs = ["203.0.113.7/32", "2001:db8::1/128"] }
}

run "rejects_open_ipv4" {
  command = plan
  variables { admin_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.admin_cidrs]
}

run "rejects_open_ipv6" {
  command = plan
  variables { admin_cidrs = ["::/0"] }
  expect_failures = [var.admin_cidrs]
}

run "rejects_garbage" {
  command = plan
  variables { admin_cidrs = ["not-a-cidr"] }
  expect_failures = [var.admin_cidrs]
}
