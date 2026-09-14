terraform {
  required_version = ">= 1.4.0"
}

variable "name" {
  description = "Sandbox name"
  type        = string
}

variable "base_template" {
  description = "CubeSandbox AppSnapshot template; empty uses the KakuriZai default"
  type        = string
  default     = ""
}

variable "cpu" {
  description = "CPU allocation in millicores"
  type        = string
  default     = "2000m"
}

variable "memory" {
  description = "Memory allocation"
  type        = string
  default     = "4000Mi"
}

variable "disk_size" {
  description = "Writable root disk size"
  type        = string
  default     = "20G"
}

variable "startup_script" {
  description = "Runs once after the sandbox is ready"
  type        = string
  default     = ""
}

module "sandbox" {
  source = "./.kakurizai/modules/sandbox"

  name           = var.name
  base_template  = var.base_template
  cpu            = var.cpu
  memory         = var.memory
  disk_size      = var.disk_size
  startup_script = var.startup_script
  network = {
    type                = "tap"
    allowInternetAccess = true
  }
  host_mounts = []
  kubernetes  = { enabled = false }
  labels = {
    "kakurizai.profile"    = "developer-sandbox"
    "kakurizai.managed-by" = "terraform-template"
  }
}

output "sandbox_name" {
  value = module.sandbox.name
}
