output "vpc_id" { value = aws_vpc.demo.id }
output "vpc_cidr" { value = aws_vpc.demo.cidr_block }
output "private_subnet_cidrs" { value = aws_subnet.private[*].cidr_block }
output "private_route_table_id" { value = aws_route_table.private.id }
output "cluster_name" { value = aws_eks_cluster.demo.name }
output "app_ecr_url" { value = aws_ecr_repository.app.repository_url }
