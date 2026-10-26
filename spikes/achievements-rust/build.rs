// Код Protobuf из неизменённых contracts/proto: protox разбирает .proto на чистом
// Rust (protoc не нужен), prost-build генерирует типы.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var("PROTO_ROOT").unwrap_or_else(|_| "../../contracts/proto".into());
    let files = ["auction/v1/auction.proto", "auction/v1/auction_events.proto"];
    let fds = protox::compile(files.map(|f| format!("{root}/{f}")), [&root])?;
    prost_build::Config::new().compile_fds(fds)?;
    println!("cargo:rerun-if-changed={root}/auction/v1");
    Ok(())
}
