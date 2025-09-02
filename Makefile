.DEFAULT_GOAL := help
SHELL := /bin/bash

# Wait until Postgres accepts connections.
define wait_pg
	@echo "waiting for postgres…"; \
	for i in $$(seq 1 30); do \
		docker compose exec -T postgres pg_isready -U $${POSTGRES_USER:-comind} >/dev/null 2>&1 && break; \
		sleep 1; \
	done
endef

.PHONY: help install db-up db-down db-reset db-generate db-migrate db-psql dev dev-server dev-web build typecheck setup logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

db-up: ## Start the Postgres container
	docker compose up -d postgres
	$(call wait_pg)
	@echo "postgres ready on $${POSTGRES_PORT:-5432}"

db-down: ## Stop the Postgres container
	docker compose stop postgres

db-reset: ## Drop the Postgres volume and recreate (DESTRUCTIVE)
	docker compose down -v
	$(MAKE) db-up
	$(MAKE) db-migrate

db-generate: ## Generate SQL migrations from the Drizzle schema
	pnpm --filter comind-server db:generate

db-migrate: ## Apply migrations to the running Postgres
	pnpm --filter comind-server db:migrate

db-psql: ## Open a psql shell into the container
	docker compose exec postgres psql -U $${POSTGRES_USER:-comind} -d $${POSTGRES_DB:-comind}

setup: install db-up db-migrate ## One-shot first-time setup

dev: db-up ## Start Postgres + server + web (watch)
	pnpm dev

dev-server: db-up ## Start Postgres + server only
	pnpm dev:server

dev-web: ## Start the web UI only
	pnpm dev:web

build: ## Build server + web
	pnpm build

typecheck: ## Typecheck all packages
	pnpm typecheck

logs: ## Tail Postgres logs
	docker compose logs -f postgres
