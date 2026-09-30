class UserService:
    def get_user(self, user_id: int) -> dict:
        return {"id": user_id, "name": "Alice"}

    def create_user(self, name: str) -> dict:
        return {"id": 1, "name": name}

def validate_email(email: str) -> bool:
    return "@" in email

import functools

def log_call(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper

@log_call
def get_all_users() -> list:
    return []
