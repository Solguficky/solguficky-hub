# Stage 1: Chef - prepare recipe for dependency caching
FROM rust:1.75-slim as chef
WORKDIR /app
RUN cargo install cargo-chef

# Stage 2: Planner - analyze dependencies
FROM chef AS planner
COPY services/telegram-gateway/Cargo.toml services/telegram-gateway/Cargo.lock ./
COPY services/telegram-gateway/src ./src
COPY services/telegram-gateway/build.rs ./build.rs
COPY contracts/proto ../../contracts/proto
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: Builder - build dependencies and application
FROM chef AS builder
# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy recipe and build dependencies (cached layer)
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# Copy source code and proto files
COPY services/telegram-gateway/Cargo.toml services/telegram-gateway/Cargo.lock ./
COPY services/telegram-gateway/src ./src
COPY services/telegram-gateway/build.rs ./build.rs
COPY contracts/proto ../../contracts/proto

# Build application
RUN cargo build --release

# Stage 4: Runtime - minimal image
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/telegram-gateway /app/telegram-gateway

# Copy configuration
COPY services/telegram-gateway/configuration.yaml /app/configuration.yaml

# Set environment
ENV RUST_LOG=info

# Run the application
CMD ["/app/telegram-gateway"]

