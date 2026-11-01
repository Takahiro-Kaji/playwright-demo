terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# The corporate IdP owns user assignment and authentication policy. No local
# Cognito users are enabled for this client.
resource "aws_cognito_user_pool" "ui" {
  name                     = var.name
  auto_verified_attributes = []
  admin_create_user_config { allow_admin_create_user_only = true }
}

resource "aws_cognito_identity_provider" "corporate" {
  user_pool_id  = aws_cognito_user_pool.ui.id
  provider_name = "CorporateSSO"
  provider_type = "SAML"
  provider_details = {
    MetadataURL = var.saml_metadata_url
  }
  attribute_mapping = { email = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" }
}

resource "aws_cognito_user_pool_domain" "ui" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.ui.id
}

resource "aws_cognito_user_pool_client" "alb" {
  name                                 = "alb"
  user_pool_id                         = aws_cognito_user_pool.ui.id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  callback_urls                        = ["https://${var.ui_host}/oauth2/idpresponse"]
  supported_identity_providers         = [aws_cognito_identity_provider.corporate.provider_name]
  prevent_user_existence_errors        = "ENABLED"
}

output "user_pool_arn" { value = aws_cognito_user_pool.ui.arn }
output "user_pool_client_id" { value = aws_cognito_user_pool_client.alb.id }
output "user_pool_domain" { value = aws_cognito_user_pool_domain.ui.domain }
output "saml_entity_id" { value = "urn:amazon:cognito:sp:${aws_cognito_user_pool.ui.id}" }
output "saml_acs_url" { value = "https://${aws_cognito_user_pool_domain.ui.domain}.auth.${var.region}.amazoncognito.com/saml2/idpresponse" }
