{{- define "ale.image" -}}{{ .root.Values.image.registry }}{{ .name }}:{{ .root.Values.image.tag }}{{- end -}}
{{- define "ale.labels" -}}
app.kubernetes.io/part-of: author-launch-engine
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "ale.secretName" -}}{{ .Values.existingSecret | default (printf "%s-secrets" .Release.Name) }}{{- end -}}
{{- define "ale.dbHost" -}}{{ .Release.Name }}-postgres{{- end -}}
{{/* The environment every app process gets. The key file is a mounted secret (STORY-049). */}}
{{- define "ale.appEnv" -}}
- name: NODE_ENV
  value: production
- name: APP_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "ale.secretName" . }}, key: app-db-password } }
- name: OWNER_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "ale.secretName" . }}, key: owner-db-password } }
- name: DATABASE_URL
  value: postgres://ale_app_login:$(APP_DB_PASSWORD)@{{ include "ale.dbHost" . }}:5432/author_launch_engine
- name: MIGRATION_DATABASE_URL
  value: postgres://postgres:$(OWNER_DB_PASSWORD)@{{ include "ale.dbHost" . }}:5432/author_launch_engine
- name: JWT_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "ale.secretName" . }}, key: jwt-secret } }
- name: AUDIT_KEY_FILE
  value: /run/secrets/audit/audit-key
{{- if .Values.search.enabled }}
- name: ELASTICSEARCH_URL
  value: http://{{ .Release.Name }}-search:9200
{{- end }}
{{- end -}}
{{- define "ale.auditKeyVolume" -}}
- name: audit-key
  secret:
    secretName: {{ include "ale.secretName" . }}
    items: [{ key: audit-key, path: audit-key }]
    defaultMode: 0440
{{- end -}}
{{/* App pods: the image's numeric user (10001), and the mounted key readable by its group (STORY-054). */}}
{{- define "ale.appPodSecurity" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: { type: RuntimeDefault }
{{- end -}}
{{- define "ale.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  seccompProfile: { type: RuntimeDefault }
{{- end -}}
{{- define "ale.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
{{- end -}}
