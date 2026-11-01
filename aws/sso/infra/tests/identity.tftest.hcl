mock_provider "aws" {}

variables {
  region                = "ap-northeast-1"
  name                  = "test"
  cognito_domain_prefix = "example-test"
  ui_host               = "sales.example.com"
}

run "local_identity" {
  command = plan
  assert {
    condition     = length(aws_cognito_identity_provider.corporate) == 0 && toset(aws_cognito_user_pool_client.alb.supported_identity_providers) == toset(["COGNITO"])
    error_message = "local mode must enable only Cognito users"
  }
  assert {
    condition     = aws_cognito_user_pool.ui.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool_client.alb.generate_secret && toset(aws_cognito_user_pool_client.alb.allowed_oauth_flows) == toset(["code"]) && contains(aws_cognito_user_pool_client.alb.callback_urls, "https://sales.example.com/oauth2/idpresponse")
    error_message = "local client must be admin-only and use the ALB callback"
  }
}

run "saml_identity" {
  command = plan
  variables {
    identity_mode     = "saml"
    saml_metadata_url = "https://idp.example.com/metadata"
  }
  assert {
    condition     = length(aws_cognito_identity_provider.corporate) == 1 && toset(aws_cognito_user_pool_client.alb.supported_identity_providers) == toset(["CorporateSSO"])
    error_message = "saml mode must enable only the corporate provider"
  }
}

run "saml_requires_metadata" {
  command = plan
  variables {
    identity_mode = "saml"
  }
  expect_failures = [aws_cognito_identity_provider.corporate]
}
