require "json"
require "securerandom"

def required(name)
  value = ENV[name]
  raise "#{name} is required" if value.nil? || value.empty?
  value
end

def positive_integer(name)
  value = Integer(required(name), 10)
  raise "#{name} must be positive" if value < 1
  value
end

def record_with_id(model, id)
  model.find_by(id: id) || model.new(id: id)
end

custom_field_ids = JSON.parse(required("FEEDBACK_REDMINE_CUSTOM_FIELD_IDS_JSON"))
expected_field_keys = %w[
  threadId requestHash applicationKey environmentKey externalWorkspaceKey pageKey
  hostResourceKey perspectiveCode locator submittedById submittedByName
]
raise "custom field keys mismatch" unless custom_field_ids.keys.sort == expected_field_keys.sort
raise "custom field IDs must be unique" unless custom_field_ids.values.uniq.length == expected_field_keys.length

Setting.rest_api_enabled = "1"
Setting.default_language = "ja"
Setting.attachment_max_size = "10240"

open_status = record_with_id(IssueStatus, positive_integer("FEEDBACK_REDMINE_OPEN_STATUS_ID"))
open_status.name = "新規" if open_status.name.blank?
open_status.position = 1
open_status.is_closed = false
open_status.is_default = true if open_status.respond_to?(:is_default=)
open_status.save!

closed_status = record_with_id(IssueStatus, positive_integer("FEEDBACK_REDMINE_CLOSED_STATUS_ID"))
closed_status.name = "終了" if closed_status.name.blank?
closed_status.position = [closed_status.position.to_i, 2].max
closed_status.is_closed = true
closed_status.save!

tracker = record_with_id(Tracker, positive_integer("FEEDBACK_REDMINE_TRACKER_ID"))
tracker.name = "Feedback"
tracker.position = [tracker.position.to_i, 1].max
tracker.default_status = open_status
tracker.save!

priority = record_with_id(IssuePriority, positive_integer("FEEDBACK_REDMINE_DEFAULT_PRIORITY_ID"))
priority.name = "通常" if priority.name.blank?
priority.position = [priority.position.to_i, 1].max
priority.is_default = true
priority.active = true
priority.save!

role = Role.find_or_initialize_by(name: "Feedback integration")
role.position = [role.position.to_i, 1].max
role.issues_visibility = "all"
role.users_visibility = "all" if role.respond_to?(:users_visibility=)
role.permissions = %i[view_issues add_issues edit_issues add_issue_notes view_private_notes]
role.save!

user = User.find_or_initialize_by(login: "feedback_integration")
user.firstname = "Feedback"
user.lastname = "Integration"
user.mail = "feedback-integration@example.invalid"
user.status = User::STATUS_ACTIVE
if user.new_record?
  password = SecureRandom.hex(32)
  user.password = password
  user.password_confirmation = password
end
user.save!

project_id = positive_integer("FEEDBACK_REDMINE_PROJECT_ID")
project = Project.find_by(identifier: "gis-feedback") || record_with_id(Project, project_id)
raise "project ID mismatch" unless project.id.nil? || project.id == project_id
project.name = "GIS Feedback"
project.identifier = "gis-feedback"
project.description = "gis-exampleの画面内Feedback（ローカル開発専用）"
project.is_public = false
project.enabled_module_names = ["issue_tracking"]
project.save!
project.tracker_ids = [tracker.id]
project.save!

member = Member.find_or_initialize_by(project: project, user: user)
member.role_ids = [role.id]
member.save!

[open_status, closed_status].product([open_status, closed_status]).each do |old_status, new_status|
  WorkflowTransition.find_or_create_by!(
    tracker_id: tracker.id,
    role_id: role.id,
    old_status_id: old_status.id,
    new_status_id: new_status.id,
    author: false,
    assignee: false
  )
end

field_specs = {
  "threadId" => ["Feedback Thread ID", "string", true],
  "requestHash" => ["Feedback Request Hash", "string", false],
  "applicationKey" => ["Feedback Application", "string", true],
  "environmentKey" => ["Feedback Environment", "string", true],
  "externalWorkspaceKey" => ["Feedback Workspace", "string", true],
  "pageKey" => ["Feedback Page", "string", true],
  "hostResourceKey" => ["Feedback Host Resource", "string", true],
  "perspectiveCode" => ["Feedback Perspective", "string", true],
  "locator" => ["Feedback Locator", "text", false],
  "submittedById" => ["Feedback Submitted By ID", "string", false],
  "submittedByName" => ["Feedback Submitted By", "string", false]
}

field_specs.each do |key, (name, format, filter)|
  id = Integer(custom_field_ids.fetch(key))
  field = record_with_id(IssueCustomField, id)
  if field.persisted? && field.name != name
    raise "custom field ID #{id} is already used by #{field.name}"
  end
  field.name = name
  field.field_format = format
  field.is_for_all = true
  field.is_filter = filter if field.respond_to?(:is_filter=)
  field.searchable = filter if field.respond_to?(:searchable=)
  field.tracker_ids = [tracker.id]
  field.role_ids = [role.id] if field.respond_to?(:role_ids=)
  field.save!
end

api_key = required("FEEDBACK_REDMINE_GATEWAY_API_KEY")
raise "FEEDBACK_REDMINE_GATEWAY_API_KEY must be 40 hexadecimal characters" unless api_key.match?(/\A[0-9a-f]{40}\z/i)

# Redmine 7のTokenは新規作成時のbefore_createでvalueを自動生成するため、先にtokenを
# 永続化してから環境変数で注入されたgateway用keyへ更新する。
token = Token.find_or_create_by!(user: user, action: "api")
token.update!(value: api_key) unless ActiveSupport::SecurityUtils.secure_compare(token.value, api_key)

puts JSON.generate({
  status: "ok",
  projectId: project.id,
  trackerId: tracker.id,
  customFieldIds: custom_field_ids
})
