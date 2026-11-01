# Two regional EKS clusters. Only primary owns RDS; secondary never creates a DB.
module "secondary" {
  source             = "./modules/region"
  providers          = { aws = aws.secondary }
  aws_region         = var.secondary_region
  project_name       = "${var.project_name}-b"
  vpc_cidr           = var.secondary_vpc_cidr
  operator_cidr      = var.operator_cidr
  eks_version        = var.eks_version
  node_instance_type = var.node_instance_type
}
resource "aws_vpc_peering_connection" "regions" {
  vpc_id      = aws_vpc.demo.id
  peer_vpc_id = module.secondary.vpc_id
  peer_region = var.secondary_region
  auto_accept = false
  lifecycle {
    precondition {
      condition     = var.aws_region != var.secondary_region
      error_message = "Choose two different AWS regions."
    }
    precondition {
      condition     = can(cidrhost(var.vpc_cidr, 0)) && can(cidrhost(var.secondary_vpc_cidr, 0)) && endswith(var.vpc_cidr, "/16") && endswith(var.secondary_vpc_cidr, "/16") && cidrhost(var.vpc_cidr, 0) != cidrhost(var.secondary_vpc_cidr, 0)
      error_message = "This demo requires two distinct, non-overlapping IPv4 /16 VPC ranges."
    }
  }
}
resource "aws_vpc_peering_connection_accepter" "secondary" {
  provider                  = aws.secondary
  vpc_peering_connection_id = aws_vpc_peering_connection.regions.id
  auto_accept               = true
}
resource "aws_vpc_peering_connection_options" "primary" {
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.secondary.id
  requester { allow_remote_vpc_dns_resolution = true }
}
resource "aws_vpc_peering_connection_options" "secondary" {
  provider                  = aws.secondary
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.secondary.id
  accepter { allow_remote_vpc_dns_resolution = true }
}
# Explicit DB-subnet return routes; no internet route for RDS.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.demo.id
}
resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}
resource "aws_route" "database_to_secondary" {
  count                     = 2
  route_table_id            = aws_route_table.database.id
  destination_cidr_block    = module.secondary.private_subnet_cidrs[count.index]
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.secondary.id
}
resource "aws_route" "secondary_to_database" {
  provider                  = aws.secondary
  count                     = 2
  route_table_id            = module.secondary.private_route_table_id
  destination_cidr_block    = aws_subnet.database[count.index].cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.secondary.id
}
