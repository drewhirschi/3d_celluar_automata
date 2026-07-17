use nextrs::vercel::StreamingVercelLayer;
use tower::ServiceBuilder;

include!(concat!(env!("OUT_DIR"), "/nextrs_routes.rs"));

#[tokio::main]
async fn main() -> Result<(), vercel_runtime::Error> {
    let router = nextrs::router::build_router(generated_registry())
        .merge(nextrs::openapi::spec_router(generated_openapi()));
    let app = ServiceBuilder::new()
        .layer(StreamingVercelLayer::new())
        .service(router);

    vercel_runtime::run(app).await
}
