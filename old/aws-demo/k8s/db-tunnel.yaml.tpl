# A temporary, private TCP bridge to RDS solely for kubectl port-forward testing.
# No DB credentials are present. Remove it with scripts/remove-db-tunnel.sh after use.
apiVersion: apps/v1
kind: Deployment
metadata: { name: db-tunnel, namespace: integration-demo }
spec:
  replicas: 1
  selector: { matchLabels: { app: db-tunnel } }
  template:
    metadata: { labels: { app: db-tunnel } }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: tunnel
          image: ${APP_IMAGE}
          command: ["node", "/srv/db-tunnel.cjs"]
          imagePullPolicy: IfNotPresent
          env:
            - { name: RDS_HOST, value: "${RDS_HOST}" }
          ports: [{ containerPort: 3306, name: tcp-mysql }]
          readinessProbe: { tcpSocket: { port: tcp-mysql }, periodSeconds: 5 }
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
metadata: { name: db-tunnel, namespace: integration-demo }
spec:
  type: ClusterIP
  selector: { app: db-tunnel }
  ports: [{ port: 3306, targetPort: tcp-mysql, protocol: TCP }]
