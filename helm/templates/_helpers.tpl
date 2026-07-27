{{/*
Expand the chart name (honours nameOverride).
*/}}
{{- define "ryasai-chatbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name — unique across releases.
*/}}
{{- define "ryasai-chatbot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "ryasai-chatbot.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{ include "ryasai-chatbot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels — must match Deployment.spec.selector exactly.
Kept disjoint from the scheduler via app.kubernetes.io/component.
*/}}
{{- define "ryasai-chatbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ryasai-chatbot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
