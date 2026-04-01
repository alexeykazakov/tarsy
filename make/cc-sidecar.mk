# =============================================================================
# Claude Code Sidecar (containerized)
# =============================================================================

CC_SIDECAR_DIR      := services/claude-code-sidecar
CC_SIDECAR_IMAGE    := tarsy-cc-sidecar:dev
CC_SIDECAR_NAME     := tarsy-cc-sidecar
CC_SIDECAR_PORT     := 3100
CC_SIDECAR_ENV_FILE := deploy/config/.env

.PHONY: cc-sidecar-build
cc-sidecar-build: ## Build CC sidecar container image
	@echo -e "$(YELLOW)Building CC sidecar container image...$(NC)"
	@podman build -t $(CC_SIDECAR_IMAGE) -f $(CC_SIDECAR_DIR)/Containerfile .
	@echo -e "$(GREEN)✅ CC sidecar image built: $(CC_SIDECAR_IMAGE)$(NC)"

.PHONY: cc-sidecar-run
cc-sidecar-run: ## Start CC sidecar container (port 3100)
	@-podman stop $(CC_SIDECAR_NAME) 2>/dev/null; podman rm $(CC_SIDECAR_NAME) 2>/dev/null; true
	@echo -e "$(YELLOW)Starting CC sidecar container on :$(CC_SIDECAR_PORT)...$(NC)"
	@podman run -d \
		--name $(CC_SIDECAR_NAME) \
		-p $(CC_SIDECAR_PORT):3100 \
		--cap-drop=ALL \
		--security-opt=no-new-privileges \
		--read-only \
		--tmpfs /tmp:rw,noexec,nosuid \
		--tmpfs /home/claude/.claude:rw \
		--memory=4g \
		--cpus=4 \
		-v $${HOME}/.kube:/home/claude/.kube:ro \
		--env-file $(CC_SIDECAR_ENV_FILE) \
		$(CC_SIDECAR_IMAGE)
	@echo -e "$(GREEN)✅ CC sidecar running: $(CC_SIDECAR_NAME)$(NC)"

.PHONY: cc-sidecar-stop
cc-sidecar-stop: ## Stop CC sidecar container
	@echo -e "$(YELLOW)Stopping CC sidecar container...$(NC)"
	@-podman stop $(CC_SIDECAR_NAME) 2>/dev/null; podman rm $(CC_SIDECAR_NAME) 2>/dev/null; true
	@echo -e "$(GREEN)✅ CC sidecar stopped$(NC)"

.PHONY: cc-sidecar-logs
cc-sidecar-logs: ## Follow CC sidecar container logs
	@podman logs -f $(CC_SIDECAR_NAME)

.PHONY: cc-sidecar-typecheck
cc-sidecar-typecheck: ## TypeScript check for CC sidecar
	@echo -e "$(YELLOW)Checking CC sidecar TypeScript...$(NC)"
	@cd $(CC_SIDECAR_DIR) && npx tsc --noEmit
	@echo -e "$(GREEN)✅ CC sidecar TypeScript check passed$(NC)"
