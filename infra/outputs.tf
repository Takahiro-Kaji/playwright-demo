output "region" {
  value = var.aws_region
}
output "cluster_name" {
  value = aws_eks_cluster.demo.name
}
output "database_host" {
  value = aws_db_instance.mysql.address
}
output "database_name" {
  value = aws_db_instance.mysql.db_name
}
output "db_master_secret_arn" {
  value = aws_db_instance.mysql.master_user_secret[0].secret_arn
}
output "app_ecr_url" {
  value = aws_ecr_repository.app.repository_url
}
output "mock_ecr_url" {
  value = aws_ecr_repository.mock.repository_url
}
output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "secondary_region" { value = var.secondary_region }
output "secondary_cluster_name" { value = module.secondary.cluster_name }
output "secondary_app_ecr_url" { value = module.secondary.app_ecr_url }
output "secondary_mock_ecr_url" { value = module.secondary.mock_ecr_url }
