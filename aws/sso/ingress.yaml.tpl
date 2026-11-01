apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sales-sso
  namespace: ${SALES_NAMESPACE}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: '${CERTIFICATE_ARN}'
    alb.ingress.kubernetes.io/inbound-cidrs: '${OPERATOR_CIDR}'
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/auth-type: cognito
    alb.ingress.kubernetes.io/auth-on-unauthenticated-request: authenticate
    alb.ingress.kubernetes.io/auth-idp-cognito: '{"userPoolARN":"${USER_POOL_ARN}","userPoolClientID":"${USER_POOL_CLIENT_ID}","userPoolDomain":"${USER_POOL_DOMAIN}"}'
spec:
  ingressClassName: alb
  rules:
    - host: '${UI_HOST}'
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sales-app
                port: { number: 8080 }
