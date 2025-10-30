.PHONY: up down logs test build

build:
	docker-compose build

up:
	docker-compose up -d
	@echo "✅ Services started"
	@echo "   NATS:     http://localhost:8222"
	@echo "   Surveyor: http://localhost:7777"

down:
	docker-compose down -v

logs:
	docker-compose logs -f notifications-service

test:
	@echo "Publishing test event..."
	cd ../../tools/nats-tester && nats-tester test

rebuild:
	docker-compose build --no-cache
	docker-compose up -d

clean:
	docker-compose down -v