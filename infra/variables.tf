variable "aws_region" {
  description = "Region in which all demo resources are created."
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Unique prefix for AWS resource names in this account/region."
  type        = string
  default     = "play-right-demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,29}$", var.project_name))
    error_message = "Use 4-30 lowercase letters, numbers and hyphens, starting with a letter."
  }
}

variable "operator_cidr" {
  description = "Required fixed public IPv4 CIDR of the operator (example: 198.51.100.20/32). No open-to-world default."
  type        = string
  validation {
    condition     = can(cidrhost(var.operator_cidr, 0)) && var.operator_cidr != "0.0.0.0/0"
    error_message = "Set your actual public IPv4 CIDR; 0.0.0.0/0 is forbidden."
  }
}

variable "eks_version" {
  description = "EKS Kubernetes version under standard support; verify region availability before apply."
  type        = string
  default     = "1.37"
}

variable "node_instance_type" {
  description = "EC2 managed node group instance type (x86_64)."
  type        = string
  default     = "t3.medium"
}

variable "db_instance_class" {
  description = "Small, non-production RDS MySQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}
