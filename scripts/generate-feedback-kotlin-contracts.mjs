#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import yaml from "js-yaml";

const input = path.resolve(process.argv[2] ?? "contracts/feedback/openapi.yaml");
const output = path.resolve(process.argv[3] ?? "contracts/feedback/kotlin/FeedbackContractTypes.kt");
const document = yaml.load(fs.readFileSync(input, "utf8"));
const schemas = document?.components?.schemas;
if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) throw new Error("components.schemas がありません");

const declarations = Object.entries(schemas).map(([name, schema]) => declaration(name, schema));
const source = `// このファイルは contracts/feedback/openapi.yaml から生成されます。直接編集しないでください。
@file:Suppress("unused")

package feedback.contract.generated

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

${declarations.join("\n\n")}
`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, source);

function declaration(name, schema) {
  if (schema.$ref?.startsWith("./schemas/")) return `typealias ${name} = JsonObject`;
  if (Array.isArray(schema.enum) || schema.oneOf) {
    return `typealias ${name} = ${schema.oneOf ? "JsonElement" : "String"}`;
  }
  if (schema.type !== "object") return `typealias ${name} = JsonElement`;
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return `typealias ${name} = JsonObject`;
  const fields = properties.map(([propertyName, property]) => {
    const mandatory = required.has(propertyName);
    const type = kotlinType(property);
    const nullableType = mandatory || type.endsWith("?") ? type : `${type}?`;
    return `    val ${identifier(propertyName)}: ${nullableType}${mandatory ? "" : " = null"}`;
  });
  return `@Serializable\ndata class ${name}(\n${fields.join(",\n")}\n)`;
}

function kotlinType(schema) {
  if (!schema || typeof schema !== "object") return "JsonElement";
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (Array.isArray(schema.enum)) return "String";
  if (schema.oneOf) return "JsonElement";
  const rawType = Array.isArray(schema.type) ? schema.type.find((value) => value !== "null") : schema.type;
  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  let type;
  switch (rawType) {
    case "string": type = "String"; break;
    case "integer": type = "Long"; break;
    case "number": type = "Double"; break;
    case "boolean": type = "Boolean"; break;
    case "array": type = `List<${kotlinType(schema.items)}>`; break;
    case "object": {
      const additional = schema.additionalProperties;
      type = additional && typeof additional === "object"
        ? `Map<String, ${kotlinType(additional)}>`
        : "JsonObject";
      break;
    }
    default: type = "JsonElement";
  }
  return nullable ? `${type}?` : type;
}

function identifier(value) {
  return /^(as|break|class|continue|do|else|false|for|fun|if|in|interface|is|null|object|package|return|super|this|throw|true|try|typealias|typeof|val|var|when|while)$/.test(value)
    ? `\`${value}\``
    : value;
}
