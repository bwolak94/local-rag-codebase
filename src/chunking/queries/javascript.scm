(function_declaration name: (identifier) @name) @symbol
(method_definition name: (property_identifier) @name) @symbol
(class_declaration name: (type_identifier) @name) @symbol
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function) @symbol))
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function) @symbol))
