apiVersion: v1
kind: Namespace
metadata: { name: ${SALES_NAMESPACE}, labels: { sales-run: "${SALES_RUN_LABEL}" } }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: sales-catalog, namespace: ${SALES_NAMESPACE} }
data:
  catalog.json: '${SALES_CATALOG}'
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: sales-upstream, namespace: ${SALES_NAMESPACE} }
spec:
  replicas: 1
  selector: { matchLabels: { app: sales-upstream } }
  template:
    metadata: { labels: { app: sales-upstream } }
    spec:
      containers:
        - name: upstream
          image: ${SALES_IMAGE}
          command: [node, aws/sales/runtime.ts, ${SALES_UPSTREAM_MODE}]
          env:
            - { name: PORT, value: "8081" }
            - { name: SALES_CATALOG_FILE, value: /catalog/catalog.json }
            - { name: MOCK_TOKEN, valueFrom: { secretKeyRef: { name: sales-mock, key: token } } }
          ports: [{ name: http, containerPort: 8081 }]
          volumeMounts: [{ name: sales-catalog, mountPath: /catalog, readOnly: true }]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumes: [{ name: sales-catalog, configMap: { name: sales-catalog } }]
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
---
apiVersion: v1
kind: Service
metadata: { name: sales-upstream, namespace: ${SALES_NAMESPACE} }
spec:
  selector: { app: sales-upstream }
  ports: [{ port: 8081, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: sales-app, namespace: ${SALES_NAMESPACE} }
spec:
  replicas: 1
  selector: { matchLabels: { app: sales-app } }
  template:
    metadata: { labels: { app: sales-app } }
    spec:
      containers:
        - name: app
          image: ${SALES_IMAGE}
          env: &salesenv
            - { name: PORT, value: "8080" }
            - { name: UPSTREAM_URL, value: "http://sales-upstream:8081/" }
            - { name: DB_HOST, value: "${DB_HOST}" }
            - { name: DB_NAME, value: ${SALES_DB_NAME} }
            - { name: DB_USER, valueFrom: { secretKeyRef: { name: sales-db, key: username } } }
            - { name: DB_PASSWORD, valueFrom: { secretKeyRef: { name: sales-db, key: password } } }
            - { name: DB_CA_FILE, value: /certs/global-bundle.pem }
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, initialDelaySeconds: 3, periodSeconds: 5 }
          volumeMounts: [{ name: rds-ca, mountPath: /certs, readOnly: true }]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumes: [{ name: rds-ca, configMap: { name: rds-ca } }]
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
---
apiVersion: v1
kind: Service
metadata: { name: sales-app, namespace: ${SALES_NAMESPACE} }
spec:
  selector: { app: sales-app }
  ports: [{ port: 8080, targetPort: http }]
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: sales-batch, namespace: ${SALES_NAMESPACE} }
spec:
  schedule: "0 0 1 1 *"
  suspend: true
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 180
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: batch
              image: ${SALES_IMAGE}
              command: [node, aws/sales/runtime.ts, batch]
              env:
                - { name: UPSTREAM_URL, value: "http://sales-upstream:8081/" }
                - { name: DB_HOST, value: "${DB_HOST}" }
                - { name: DB_NAME, value: ${SALES_DB_NAME} }
                - { name: DB_USER, valueFrom: { secretKeyRef: { name: sales-db, key: username } } }
                - { name: DB_PASSWORD, valueFrom: { secretKeyRef: { name: sales-db, key: password } } }
                - { name: DB_CA_FILE, value: /certs/global-bundle.pem }
              volumeMounts: [{ name: rds-ca, mountPath: /certs, readOnly: true }]
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          volumes: [{ name: rds-ca, configMap: { name: rds-ca } }]
          securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
