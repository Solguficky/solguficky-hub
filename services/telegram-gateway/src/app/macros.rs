#[macro_export]
macro_rules! wrap_handler {
    ($wrapper_name:ident, $handler:ident($($param:ident : $ty:ty),*)) => {
        pub async fn $wrapper_name($($param: $ty,)* bot: ::teloxide::prelude::Bot) -> ::anyhow::Result<()> {
            $crate::helpers::handle_with_action(bot, || $handler($($param),*)).await
        }
    };
}

#[macro_export]
macro_rules! callback_routes {
    ($($pattern:literal => $wrapper:ident $([$filter:ident])?),* $(,)?) => {
        ::teloxide::dptree::entry()
            $(
                .branch(
                    ::teloxide::dptree::filter(|q: ::teloxide::types::CallbackQuery| {
                        callback_routes!(@match_pattern q, $pattern)
                    })
                    $(
                        .filter($filter)
                    )?
                    .endpoint($wrapper)
                )
            )*
    };

    (@match_pattern $q:ident, $pattern:literal) => {
        $q.data
            .as_ref()
            .map(|d| {
                if $pattern.ends_with(':') {
                    d.starts_with($pattern)
                } else {
                    d.as_str() == $pattern
                }
            })
            .unwrap_or(false)
    };
}
