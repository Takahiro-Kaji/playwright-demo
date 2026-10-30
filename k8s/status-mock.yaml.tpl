apiVersion: apps/v1
kind: Deployment
metadata:
  name: status-mock
  namespace: integration-demo
spec:
  replicas: 1
  selector: { matchLabels: { app: status-mock } }
  template:
    metadata: { labels: { app: status-mock } }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: mock
          image: ${MOCK_IMAGE}
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 8081, name: http }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, initialDelaySeconds: 2, periodSeconds: 5 }
          resources:
            requests: { cpu: 25m, memory: 48Mi }
            limits: { cpu: 250m, memory: 128Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
---
apiVersion: v1
kind: Service
metadata: { name: status-mock, namespace: integration-demo }
spec:
  type: ClusterIP
  selector: { app: status-mock }
  ports: [{ port: 8081, targetPort: http, protocol: TCP }]
