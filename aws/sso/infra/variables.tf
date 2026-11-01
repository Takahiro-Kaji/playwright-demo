variable "region" { type = string }
variable "name" { type = string }
variable "cognito_domain_prefix" { type = string }
variable "ui_host" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.ui_host)) && !strcontains(var.ui_host, "..")
    error_message = "ui_host must be a lowercase DNS hostname without a scheme or path."
  }
}
variable "identity_mode" {
  type    = string
  default = "local"
  validation {
    condition     = contains(["local", "saml"], var.identity_mode)
    error_message = "identity_mode must be local or saml."
  }
}
variable "saml_metadata_url" {
  type    = string
  default = ""
  validation {
    condition     = var.saml_metadata_url == "" || can(regex("^https://[^?#[:space:]]+$", var.saml_metadata_url))
    error_message = "Use the corporate IdP's HTTPS SAML metadata URL without query or fragment."
  }
}
