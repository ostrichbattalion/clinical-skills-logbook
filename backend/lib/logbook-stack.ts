import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { routeKeys } from '../src/handler.js';
import { ROLES } from '../src/domain.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface LogbookStackProps extends cdk.StackProps {
  stage: string;
  allowedOrigins: string[];
}

export class LogbookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LogbookStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';

    // ---- Data: one table, point-in-time recovery on, never deleted with the stack ----
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: isProd,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'GSI2',
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---- Identity: institution-managed accounts only (no self sign-up) ----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `clinical-logbook-${props.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: true, mutable: true } },
      customAttributes: {
        institution: new cognito.StringAttribute({ minLen: 1, maxLen: 120, mutable: true }),
        category: new cognito.StringAttribute({ minLen: 3, maxLen: 12, mutable: true }), // ECA | PARAMEDIC | ECP
        reg_no: new cognito.StringAttribute({ maxLen: 40, mutable: true }), // HPCSA registration number
        programme: new cognito.StringAttribute({ maxLen: 40, mutable: true }), // requirement-set programme id, e.g. WCG-DIPEMC
        study_year: new cognito.StringAttribute({ maxLen: 2, mutable: true }), // current year of study, "1".."6"
      },
      passwordPolicy: { minLength: 10, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Your clinical skills logbook account',
        emailBody: 'You have been given a clinical skills logbook account. Sign in with {username} and the temporary password {####}. You will be asked to choose a new password.',
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    for (const role of ROLES) {
      new cognito.CfnUserPoolGroup(this, `Group-${role}`, { userPoolId: userPool.userPoolId, groupName: role });
    }

    // The browser client may read profile attributes but write none of them: students must not be able to
    // change their own registration category, institution or registration number.
    const client = userPool.addClient('WebClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true, fullname: true })
        .withCustomAttributes('institution', 'category', 'reg_no', 'programme', 'study_year'),
      writeAttributes: new cognito.ClientAttributes(),
    });

    // ---- API: one Lambda behind an HTTP API with a Cognito JWT authorizer ----
    const fn = new NodejsFunction(this, 'ApiFunction', {
      entry: join(here, '../src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024, // reports compute a whole cohort in one request
      timeout: cdk.Duration.seconds(20),
      environment: { TABLE_NAME: table.tableName, USER_POOL_ID: userPool.userPoolId },
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22',
        banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);" },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser'],
        resources: [userPool.userPoolArn],
      }),
    );

    const api = new HttpApi(this, 'Api', {
      apiName: `clinical-logbook-${props.stage}`,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const defaultStage = api.defaultStage?.node.defaultChild as cdk.aws_apigatewayv2.CfnStage;
    defaultStage.defaultRouteSettings = { throttlingRateLimit: 25, throttlingBurstLimit: 50 };

    const authorizer = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
      jwtAudience: [client.userPoolClientId],
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    for (const key of routeKeys) {
      const [method, path] = key.split(' ');
      api.addRoutes({ path, methods: [method as HttpMethod], integration, authorizer });
    }

    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
