use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeIdentity {
    #[serde(
        rename = "tab_instance",
        skip_deserializing,
        skip_serializing_if = "private_object"
    )]
    pub retained_object: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<crate::ElementIdentifier>,
}

fn private_object(object: &Option<String>) -> bool {
    !object
        .as_deref()
        .is_some_and(|id| id.starts_with("tab-instance:"))
}
