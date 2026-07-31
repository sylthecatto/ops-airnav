pipeline {
    agent any

    environment {
        REGISTRY = 'localhost:5050'
        IMAGE = "${REGISTRY}/new-app:${BUILD_NUMBER}",
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build') {
            steps {
                sh 'docker build -t new-app:build-${BUILD_NUMBER} ,'
            }
        }

        stage('Push') {
            steps {
                sh '''
                    docker tag new-app:build-${BUILD_NUMBER} ${IMAGE}
                    docker push ${IMAGE}
                '''
            }
        }
    }
}
