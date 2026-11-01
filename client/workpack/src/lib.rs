//! planetCompute WorkPacks (docs/SHERPAHUB.md).
//!
//! * [`kernels`]: the maths a pack asks for, identical on every machine (program and browser).
//! * [`wire`]: the binary messages between a SherpaHub and its devices.
//! * [`device`]: what a contributor does with those messages (block cache, compute, answer).
//! * [`store`]: the SherpaHub's crash-safe checkpoint directory.
//! * [`hub`]: the SherpaHub itself, a pure state machine driven by events and a clock passed in.
//!
//! A regular program DOES the work ([`device`]); a SherpaHub ORGANISES the work ([`hub`]).

pub mod device;
pub mod hub;
pub mod kernels;
pub mod store;
pub mod wire;
