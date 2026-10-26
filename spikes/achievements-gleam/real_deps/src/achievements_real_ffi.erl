-module(achievements_real_ffi).
-export([env_flag/1]).

env_flag(Name) -> os:getenv(binary_to_list(Name)) =:= "1".
