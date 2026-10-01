(function_declaration name: (identifier) @name) @symbol
(method_definition name: (property_identifier) @name) @symbol
(class_declaration name: (type_identifier) @name) @symbol
(interface_declaration name: (type_identifier) @name) @symbol
(type_alias_declaration name: (type_identifier) @name) @symbol
(export_statement declaration: [
  (function_declaration name: (identifier) @name)
  (class_declaration name: (type_identifier) @name)
  (interface_declaration name: (type_identifier) @name)
  (type_alias_declaration name: (type_identifier) @name)
] @symbol)
