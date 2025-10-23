use std::io::Result;

fn main() -> Result<()> {
    let proto_root = "../../contracts/proto";
    let proto_files: Vec<_> = glob::glob(&format!("{}/**/*.proto", proto_root))
        .expect("Failed to read glob pattern")
        .filter_map(std::result::Result::ok)
        .collect();

    let proto_paths: Vec<_> = proto_files.iter().map(|p| p.to_str().unwrap()).collect();

    let mut config = prost_build::Config::new();
    config.protoc_arg("--experimental_allow_proto3_optional");
    config.compile_protos(&proto_paths, &[proto_root])?;

    Ok(())
}
