//! Version fixture for the production MCP server/WorkerClient probe. No input APIs.
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let after_id = line.split("\"id\":").nth(1).unwrap();
        let id: String = after_id.chars().take_while(|c| c.is_ascii_digit()).collect();
        let response = if line.contains("\"command\":\"hello\"") {
            "\"ok\":true,\"result\":{\"version\":\"0.2.1\",\"protocol\":2,\"platform\":\"windows\",\"capabilities\":{}}"
        } else if line.contains("\"command\":\"observe\"") && line.contains("\"hwnd\":\"18446744073709551616\"") {
            "\"ok\":false,\"error\":{\"code\":\"invalid_hwnd\",\"message\":\"Out of range readonly fixture handle\"}"
        } else if line.contains("\"command\":\"ping\"") {
            "\"ok\":true,\"result\":{\"alive\":true}"
        } else {
            "\"ok\":false,\"error\":{\"code\":\"fixture_forbidden_command\",\"message\":\"Only hello, ping and invalid observe are allowed\"}"
        };
        println!("{{\"id\":{id},{response}}}");
    }
}
