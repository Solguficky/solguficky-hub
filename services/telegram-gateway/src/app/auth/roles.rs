use crate::config::Auth;
use teloxide::types::UserId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserRole {
    Admin,
    User,
}

pub fn get_user_role(user_id: UserId, config: &Auth) -> UserRole {
    let user_id_i64 = user_id.0 as i64;

    if config.admins.contains(&user_id_i64) {
        UserRole::Admin
    } else {
        UserRole::User
    }
}
