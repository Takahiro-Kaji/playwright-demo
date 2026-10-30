apiVersion: apps/v1
kind: Deployment
metadata: { name: demo-app, namespace: integration-demo }
spec:
  replicas: 1
  selector: { matchLabels: { app: demo-app } }
  template:
    metadata: { labels: { app: demo-app } }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: ${APP_IMAGE}
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 8080, name: http }]
          env:
            - { name: PORT, value: "8080" }
            - { name: APP_REGION, value: "${APP_REGION}" }
            - { name: MOCK_URL, value: "http://status-mock:8081" }
            - { name: DB_HOST, value: "${RDS_HOST}" }
            - { name: DB_NAME, value: integration_demo }
            - { name: DB_USER, valueFrom: { secretKeyRef: { name: app-db, key: username } } }
            - { name: DB_PASSWORD, valueFrom: { secretKeyRef: { name: app-db, key: password } } }
            - { name: DB_CA_FILE, value: /srv/certs/global-bundle.pem }
          volumeMounts:
            - { name: rds-ca, mountPath: /srv/certs, readOnly: true }
          readinessProbe: { httpGet: { path: /healthz, port: http }, initialDelaySeconds: 3, periodSeconds: 5 }
          resources:
            requests: { cpu: 50m, memory: 96Mi }
            limits: { cpu: 500m, memory: 256Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
      volumes:
        - name: rds-ca
          configMap: { name: rds-ca, defaultMode: 0444 }
---
apiVersion: v1
kind: Service
metadata: { name: demo-app, namespace: integration-demo }
spec:
  type: ClusterIP
  selector: { app: demo-app }
  ports: [{ port: 8080, targetPort: http, protocol: TCP }]
