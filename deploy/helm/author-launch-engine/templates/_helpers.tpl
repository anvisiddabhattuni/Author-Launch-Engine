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
{{- if .Values.monitoring.enabled }}
- name: ALERTMANAGER_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "ale.secretName" . }}, key: alertmanager-token } }
{{- end }}
{{- if .Values.search.enabled }}
- name: ELASTICSEARCH_URL
  value: http://{{ .Release.Name }}-search:9200
{{- end }}
{{- end -}}
{{/*
  An autoscaler for one Deployment (STORY-054, extended to every service by
  STORY-060). CPU always; memory too where set. Up fast, down slowly: one
  quiet minute must not shed the pods the next busy one needs.
*/}}
{{- define "ale.hpa" -}}
{{- $a := .spec.autoscaling -}}
{{- if $a.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .root.Release.Name }}-{{ .name }}
  labels: {{- include "ale.labels" .root | nindent 4 }}
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: {{ .root.Release.Name }}-{{ .name }} }
  minReplicas: {{ $a.minReplicas }}
  maxReplicas: {{ $a.maxReplicas }}
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: {{ $a.targetCPUUtilizationPercentage }} } }
    {{- if $a.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource: { name: memory, target: { type: Utilization, averageUtilization: {{ $a.targetMemoryUtilizationPercentage }} } }
    {{- end }}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies: [{ type: Percent, value: 100, periodSeconds: 30 }]
    scaleDown:
      stabilizationWindowSeconds: {{ $a.scaleDownStabilizationSeconds | default 300 }}
      policies: [{ type: Pods, value: 1, periodSeconds: 60 }]
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
