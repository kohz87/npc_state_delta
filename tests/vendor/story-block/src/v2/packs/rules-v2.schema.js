// The rules pack v2 JSON Schema as a JavaScript module (SPEC §7, RB_CONTRACT.md "Machine-readable schema").
//
// Browsers and Node load this file the same way; no JSON import attribute is needed. rules-v2.schema.json
// stays next to it for tooling (editors, Studio, validators). A test keeps the two deeply equal and
// equal to the schema embedded in the contract, so edit all three together.

export const rulesV2SchemaSource = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:story-suite:rb-rules-v2:manifest",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "slug",
        "name",
        "schema",
        "classes",
        "skills",
        "branches",
        "itemRules",
        "trainers"
    ],
    "properties": {
        "slug": {
            "const": "rules"
        },
        "name": {
            "$ref": "#/$defs/name"
        },
        "schema": {
            "const": 2
        },
        "statLabels": {
            "type": "object",
            "additionalProperties": false,
            "required": [],
            "properties": {
                "STR": {
                    "$ref": "#/$defs/name"
                },
                "VIT": {
                    "$ref": "#/$defs/name"
                },
                "AGI": {
                    "$ref": "#/$defs/name"
                },
                "DEX": {
                    "$ref": "#/$defs/name"
                },
                "INT": {
                    "$ref": "#/$defs/name"
                },
                "LUK": {
                    "$ref": "#/$defs/name"
                },
                "CHA": {
                    "$ref": "#/$defs/name"
                }
            },
            "default": {}
        },
        "memory": {
            "enum": [
                "deja-vu",
                "none",
                "full"
            ],
            "default": "deja-vu"
        },
        "classes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 40,
            "items": {
                "$ref": "#/$defs/class"
            }
        },
        "skills": {
            "type": "array",
            "minItems": 3,
            "maxItems": 120,
            "items": {
                "$ref": "#/$defs/skill"
            }
        },
        "branches": {
            "type": "array",
            "minItems": 0,
            "maxItems": 1000,
            "items": {
                "$ref": "#/$defs/branch"
            }
        },
        "itemRules": {
            "type": "array",
            "minItems": 0,
            "maxItems": 1000,
            "items": {
                "$ref": "#/$defs/itemRule"
            }
        },
        "trainers": {
            "type": "array",
            "minItems": 0,
            "maxItems": 100,
            "items": {
                "$ref": "#/$defs/trainer"
            }
        }
    },
    "$defs": {
        "xpPerLevel": {
            "type": "integer",
            "minimum": 10,
            "maximum": 10000,
            "multipleOf": 10,
            "default": 100
        },
        "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^(?:[a-z][a-z0-9]*_[0-9a-z]{8}|[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[_-][a-z0-9]+)*)$"
        },
        "ref": {
            "type": "string",
            "minLength": 1,
            "maxLength": 110,
            "pattern": "^(?:pack\\.[a-z0-9]+(?:-[a-z0-9]+)*/)?[a-z0-9]+(?:-[a-z0-9]+)*$"
        },
        "slug": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
        },
        "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
        },
        "note": {
            "type": "string",
            "minLength": 0,
            "maxLength": 240,
            "default": ""
        },
        "stat": {
            "enum": [
                "STR",
                "VIT",
                "AGI",
                "DEX",
                "INT",
                "LUK",
                "CHA"
            ]
        },
        "target": {
            "enum": [
                "one",
                "all",
                "self",
                "ally",
                "allies"
            ]
        },
        "element": {
            "enum": [
                "none",
                "fire",
                "ice",
                "lightning",
                "poison",
                "holy"
            ]
        },
        "slot": {
            "enum": [
                "weapon",
                "offhand",
                "head",
                "body",
                "legs",
                "feet",
                "accessory-1",
                "accessory-2"
            ]
        },
        "stats": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "STR",
                "VIT",
                "AGI",
                "DEX",
                "INT",
                "LUK",
                "CHA"
            ],
            "properties": {
                "STR": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "VIT": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "AGI": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "DEX": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "INT": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "LUK": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "CHA": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                }
            }
        },
        "requires": {
            "type": "object",
            "additionalProperties": false,
            "required": [],
            "properties": {
                "STR": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "VIT": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "AGI": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "DEX": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "INT": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "LUK": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "CHA": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                }
            }
        },
        "cost": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "mp",
                "sp",
                "cooldown"
            ],
            "properties": {
                "mp": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 999
                },
                "sp": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 999
                },
                "cooldown": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10
                }
            }
        },
        "effect": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "target",
                        "power",
                        "element",
                        "damageType"
                    ],
                    "properties": {
                        "op": {
                            "enum": [
                                "damage",
                                "heal",
                                "shield"
                            ]
                        },
                        "target": {
                            "$ref": "#/$defs/target"
                        },
                        "power": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 1000
                        },
                        "element": {
                            "$ref": "#/$defs/element"
                        },
                        "damageType": {
                            "enum": [
                                "physical",
                                "magic",
                                null
                            ]
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "target",
                        "kind",
                        "chance",
                        "rounds"
                    ],
                    "properties": {
                        "op": {
                            "const": "condition"
                        },
                        "target": {
                            "$ref": "#/$defs/target"
                        },
                        "kind": {
                            "enum": [
                                "poison",
                                "burn",
                                "bleed",
                                "stun",
                                "daze",
                                "slow",
                                "weaken",
                                "regen",
                                "guard"
                            ]
                        },
                        "chance": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 100
                        },
                        "rounds": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 6
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "target",
                        "stat",
                        "amount",
                        "rounds"
                    ],
                    "properties": {
                        "op": {
                            "const": "stat"
                        },
                        "target": {
                            "$ref": "#/$defs/target"
                        },
                        "stat": {
                            "$ref": "#/$defs/stat"
                        },
                        "amount": {
                            "type": "integer",
                            "minimum": -10,
                            "maximum": 10,
                            "not": {
                                "const": 0
                            }
                        },
                        "rounds": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 6
                        }
                    }
                }
            ]
        },
        "base": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "type",
                "stat",
                "cost",
                "effects",
                "unit"
            ],
            "properties": {
                "type": {
                    "enum": [
                        "physical",
                        "magic",
                        "heal",
                        "buff",
                        "debuff"
                    ]
                },
                "stat": {
                    "$ref": "#/$defs/stat"
                },
                "cost": {
                    "$ref": "#/$defs/cost"
                },
                "effects": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {
                        "$ref": "#/$defs/effect"
                    }
                },
                "unit": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/unit"
                        }
                    ]
                }
            }
        },
        "class": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "tier",
                "parent",
                "skills"
            ],
            "properties": {
                "name": {
                    "$ref": "#/$defs/name"
                },
                "tier": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 3
                },
                "parent": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/ref"
                        }
                    ]
                },
                "skills": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": {
                        "$ref": "#/$defs/ref"
                    },
                    "uniqueItems": true
                },
                "note": {
                    "$ref": "#/$defs/note"
                },
                "slug": {
                    "$ref": "#/$defs/slug"
                }
            }
        },
        "skill": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "base"
            ],
            "properties": {
                "name": {
                    "$ref": "#/$defs/name"
                },
                "note": {
                    "$ref": "#/$defs/note"
                },
                "replaces": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/ref"
                        }
                    ],
                    "default": null
                },
                "base": {
                    "$ref": "#/$defs/base"
                },
                "slug": {
                    "$ref": "#/$defs/slug"
                }
            }
        },
        "transform": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "at",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-target"
                        },
                        "at": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 3
                        },
                        "value": {
                            "$ref": "#/$defs/target"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "at",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-element"
                        },
                        "at": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 3
                        },
                        "value": {
                            "$ref": "#/$defs/element"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "at",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-power"
                        },
                        "at": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 3
                        },
                        "value": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 1000
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "at",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "replace-effect"
                        },
                        "at": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 3
                        },
                        "value": {
                            "$ref": "#/$defs/effect"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "add-effect"
                        },
                        "value": {
                            "$ref": "#/$defs/effect"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "at"
                    ],
                    "properties": {
                        "op": {
                            "const": "remove-effect"
                        },
                        "at": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 3
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-cost"
                        },
                        "value": {
                            "$ref": "#/$defs/cost"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-stat"
                        },
                        "value": {
                            "$ref": "#/$defs/stat"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "op",
                        "value"
                    ],
                    "properties": {
                        "op": {
                            "const": "set-type"
                        },
                        "value": {
                            "enum": [
                                "physical",
                                "magic",
                                "heal",
                                "buff",
                                "debuff"
                            ]
                        }
                    }
                }
            ]
        },
        "branch": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "skill",
                "fromForm",
                "step",
                "choice",
                "name",
                "transforms"
            ],
            "properties": {
                "skill": {
                    "$ref": "#/$defs/ref"
                },
                "fromForm": {
                    "$ref": "#/$defs/ref"
                },
                "step": {
                    "enum": [
                        1,
                        2
                    ]
                },
                "choice": {
                    "enum": [
                        "a",
                        "b"
                    ]
                },
                "name": {
                    "$ref": "#/$defs/name"
                },
                "note": {
                    "$ref": "#/$defs/note"
                },
                "transforms": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "$ref": "#/$defs/transform"
                    }
                },
                "slug": {
                    "$ref": "#/$defs/slug"
                }
            }
        },
        "itemRule": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "def",
                "allowedSlots",
                "hands",
                "requires",
                "weight"
            ],
            "properties": {
                "def": {
                    "$ref": "#/$defs/ref"
                },
                "allowedSlots": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 2,
                    "items": {
                        "$ref": "#/$defs/slot"
                    },
                    "uniqueItems": true
                },
                "hands": {
                    "enum": [
                        0,
                        1,
                        2
                    ]
                },
                "requires": {
                    "$ref": "#/$defs/requires"
                },
                "weight": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000
                },
                "unique": {
                    "type": "boolean",
                    "default": false
                }
            }
        },
        "trainer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "place",
                "skills",
                "fee",
                "minutes",
                "eventTemplates"
            ],
            "properties": {
                "name": {
                    "$ref": "#/$defs/name"
                },
                "place": {
                    "$ref": "#/$defs/id"
                },
                "skills": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 30,
                    "items": {
                        "$ref": "#/$defs/ref"
                    },
                    "uniqueItems": true
                },
                "fee": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000000
                },
                "minutes": {
                    "const": 60
                },
                "eventTemplates": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 8,
                    "items": {
                        "$ref": "#/$defs/ref"
                    },
                    "uniqueItems": true
                },
                "slug": {
                    "$ref": "#/$defs/slug"
                }
            }
        },
        "requirement": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "min"
                    ],
                    "properties": {
                        "kind": {
                            "const": "level"
                        },
                        "min": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 99
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "stat",
                        "min"
                    ],
                    "properties": {
                        "kind": {
                            "const": "stat"
                        },
                        "stat": {
                            "$ref": "#/$defs/stat"
                        },
                        "min": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 99
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "template"
                    ],
                    "properties": {
                        "kind": {
                            "const": "quest"
                        },
                        "template": {
                            "$ref": "#/$defs/ref"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "def",
                        "qty"
                    ],
                    "properties": {
                        "kind": {
                            "const": "item"
                        },
                        "def": {
                            "$ref": "#/$defs/ref"
                        },
                        "qty": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 999
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "place"
                    ],
                    "properties": {
                        "kind": {
                            "const": "place"
                        },
                        "place": {
                            "$ref": "#/$defs/id"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "thread"
                    ],
                    "properties": {
                        "kind": {
                            "const": "thread"
                        },
                        "thread": {
                            "$ref": "#/$defs/id"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "classes"
                    ],
                    "properties": {
                        "kind": {
                            "const": "class"
                        },
                        "classes": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 40,
                            "uniqueItems": true,
                            "items": {
                                "$ref": "#/$defs/ref"
                            }
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "kind",
                        "key",
                        "value"
                    ],
                    "properties": {
                        "kind": {
                            "const": "flag"
                        },
                        "key": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 80
                        },
                        "value": {
                            "type": "boolean"
                        }
                    }
                }
            ]
        },
        "objective": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "id",
                        "kind",
                        "foe",
                        "count"
                    ],
                    "properties": {
                        "id": {
                            "$ref": "#/$defs/id"
                        },
                        "kind": {
                            "const": "kill"
                        },
                        "foe": {
                            "$ref": "#/$defs/ref"
                        },
                        "count": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 999
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "id",
                        "kind",
                        "def",
                        "count",
                        "consume"
                    ],
                    "properties": {
                        "id": {
                            "$ref": "#/$defs/id"
                        },
                        "kind": {
                            "const": "collect"
                        },
                        "def": {
                            "$ref": "#/$defs/ref"
                        },
                        "count": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 999
                        },
                        "consume": {
                            "type": "boolean"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "id",
                        "kind",
                        "place"
                    ],
                    "properties": {
                        "id": {
                            "$ref": "#/$defs/id"
                        },
                        "kind": {
                            "const": "visit"
                        },
                        "place": {
                            "$ref": "#/$defs/id"
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "id",
                        "kind",
                        "text"
                    ],
                    "properties": {
                        "id": {
                            "$ref": "#/$defs/id"
                        },
                        "kind": {
                            "const": "story"
                        },
                        "text": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 240
                        }
                    }
                }
            ]
        },
        "reward": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "coin",
                "xp",
                "items"
            ],
            "properties": {
                "coin": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                },
                "xp": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                },
                "items": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "def",
                            "qty"
                        ],
                        "properties": {
                            "def": {
                                "$ref": "#/$defs/ref"
                            },
                            "qty": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 999
                            }
                        }
                    }
                }
            }
        },
        "quest": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "category",
                "giver",
                "turnInPlace",
                "requirements",
                "objectives",
                "reward",
                "durationMinutes",
                "repeat",
                "chain"
            ],
            "properties": {
                "slug": {
                    "$ref": "#/$defs/slug"
                },
                "name": {
                    "$ref": "#/$defs/name"
                },
                "category": {
                    "enum": [
                        "main",
                        "side",
                        "bounty"
                    ]
                },
                "giver": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/id"
                        }
                    ]
                },
                "turnInPlace": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "$ref": "#/$defs/id"
                        }
                    ]
                },
                "requirements": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 16,
                    "items": {
                        "$ref": "#/$defs/requirement"
                    }
                },
                "objectives": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "$ref": "#/$defs/objective"
                    }
                },
                "reward": {
                    "$ref": "#/$defs/reward"
                },
                "durationMinutes": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 525600
                        }
                    ]
                },
                "repeat": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                                "cooldownMinutes"
                            ],
                            "properties": {
                                "cooldownMinutes": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 525600
                                }
                            }
                        }
                    ]
                },
                "chain": {
                    "oneOf": [
                        {
                            "type": "null"
                        },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                                "previous",
                                "next"
                            ],
                            "properties": {
                                "previous": {
                                    "oneOf": [
                                        {
                                            "type": "null"
                                        },
                                        {
                                            "$ref": "#/$defs/ref"
                                        }
                                    ]
                                },
                                "next": {
                                    "oneOf": [
                                        {
                                            "type": "null"
                                        },
                                        {
                                            "$ref": "#/$defs/ref"
                                        }
                                    ]
                                }
                            }
                        }
                    ]
                }
            }
        },
        "foe": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "tier",
                "level",
                "stats",
                "skills",
                "loot",
                "loreTags"
            ],
            "properties": {
                "slug": {
                    "$ref": "#/$defs/slug"
                },
                "name": {
                    "$ref": "#/$defs/name"
                },
                "tier": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9
                },
                "level": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "stats": {
                    "$ref": "#/$defs/stats"
                },
                "skills": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "$ref": "#/$defs/ref"
                    },
                    "uniqueItems": true
                },
                "loot": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "def",
                            "chance",
                            "qty"
                        ],
                        "properties": {
                            "def": {
                                "$ref": "#/$defs/ref"
                            },
                            "chance": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 100
                            },
                            "qty": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 99
                            }
                        }
                    }
                },
                "loreTags": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 8,
                    "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40
                    },
                    "uniqueItems": true
                }
            }
        },
        "shop": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "place",
                "kind",
                "stock"
            ],
            "properties": {
                "slug": {
                    "$ref": "#/$defs/slug"
                },
                "name": {
                    "$ref": "#/$defs/name"
                },
                "place": {
                    "$ref": "#/$defs/id"
                },
                "kind": {
                    "$ref": "#/$defs/slug",
                    "maxLength": 40
                },
                "stock": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "item",
                            "qty",
                            "price"
                        ],
                        "properties": {
                            "item": {
                                "$ref": "#/$defs/ref"
                            },
                            "qty": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 999
                            },
                            "price": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 9007199254740991
                            }
                        }
                    }
                }
            }
        },
        "recipe": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "slug",
                "name",
                "craft",
                "makes",
                "qty",
                "materials",
                "fee",
                "minutes",
                "dc",
                "stat"
            ],
            "properties": {
                "slug": {
                    "$ref": "#/$defs/slug"
                },
                "name": {
                    "$ref": "#/$defs/name"
                },
                "craft": {
                    "$ref": "#/$defs/slug"
                },
                "makes": {
                    "$ref": "#/$defs/ref"
                },
                "qty": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 99
                },
                "materials": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "item",
                            "qty"
                        ],
                        "properties": {
                            "item": {
                                "$ref": "#/$defs/ref"
                            },
                            "qty": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 99
                            }
                        }
                    }
                },
                "fee": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                },
                "minutes": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 1440
                },
                "dc": {
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 40
                },
                "stat": {
                    "type": "string",
                    "pattern": "^(STR|VIT|AGI|DEX|INT|LUK|CHA)(\\+(STR|VIT|AGI|DEX|INT|LUK|CHA)){0,2}$"
                },
                "station": {
                    "$ref": "#/$defs/slug"
                },
                "known": {
                    "type": "boolean",
                    "default": true
                },
                "teaches": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120
                }
            }
        },
        "unit": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "kind",
                "class",
                "statShare",
                "poolShare",
                "rounds"
            ],
            "properties": {
                "kind": {
                    "enum": [
                        "summon",
                        "pet"
                    ]
                },
                "class": {
                    "$ref": "#/$defs/ref"
                },
                "statShare": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 100
                },
                "poolShare": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 100
                },
                "rounds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 60
                }
            }
        }
    }
};
