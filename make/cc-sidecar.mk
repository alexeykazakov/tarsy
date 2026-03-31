# =============================================================================
# Claude Code Sidecar
# =============================================================================

CC_SIDECAR_DIR := services/claude-code-sidecar

.PHONY: cc-sidecar-install
cc-sidecar-install: ## Install CC sidecar dependencies
	@echo -e "$(YELLOW)Installing CC sidecar dependencies...$(NC)"
	@cd $(CC_SIDECAR_DIR) && npm install
	@echo -e "$(GREEN)✅ CC sidecar dependencies installed$(NC)"

.PHONY: cc-sidecar
cc-sidecar: ## Start CC sidecar service (port 3100)
	@echo -e "$(YELLOW)Starting CC sidecar on :3100...$(NC)"
	@cd $(CC_SIDECAR_DIR) && npm run dev

.PHONY: cc-sidecar-typecheck
cc-sidecar-typecheck: ## TypeScript check for CC sidecar
	@echo -e "$(YELLOW)Checking CC sidecar TypeScript...$(NC)"
	@cd $(CC_SIDECAR_DIR) && npx tsc --noEmit
	@echo -e "$(GREEN)✅ CC sidecar TypeScript check passed$(NC)"
