const os = require('os');
const express = require('express');
const _ = require('lodash');
const Promise = require('bluebird');

const http = require('http');
const https = require('https');

const morgan = require('morgan');
const app = express();

const body_parser = require('body-parser');
const fs = require('fs');
const yaml = require('js-yaml');
const nodePath = require('path');

const SERVER_PORT = _.get(process.env, 'SERVER_PORT');
const SERVER_TLS_KEY = _.get(process.env, 'SERVER_TLS_KEY');
const SERVER_TLS_CERT = _.get(process.env, 'SERVER_TLS_CERT');
const OPENAPI_SPEC_PATH = _.get(process.env, 'OPENAPI_SPEC_PATH', 'openapi.yaml');

const axios = require('axios');

let openapi_spec = fs.readFileSync(nodePath.resolve(process.cwd(), OPENAPI_SPEC_PATH), 'utf8');
if (/.ya?ml$/.test(OPENAPI_SPEC_PATH)) {
    openapi_spec = yaml.safeLoad(openapi_spec);
} else {
    openapi_spec = JSON.parse(openapi_spec);
}


let OpenAPIRequestValidator = require('openapi-request-validator').default;
let OpenAPIResponseValidator = require('openapi-response-validator').default;


let https_config = null;
let port;

if (!_.isEmpty(SERVER_PORT)) {
    port = _.toInteger(SERVER_PORT);
} else {
    if (!_.isEmpty(SERVER_TLS_KEY) && !_.isEmpty(SERVER_TLS_CERT)) {
        https_config = {
            key: fs.readFileSync(SERVER_TLS_KEY),
            cert: fs.readFileSync(SERVER_TLS_CERT)
        };
        port = 443;
    } else {
        port = 80;
    }
}

app.use(morgan('combined'));


app.use(body_parser.json({limit: '100MB'}));
app.use(body_parser.urlencoded({extended: true, limit: '100MB'}));


app.get('/status', function (req, res) {
    return res.jsonp({status: 'OK', hostname: os.hostname()});
});


_.each(_.get(openapi_spec, 'paths'), function (path_spec, path) {
    _.each(path_spec, function (method_spec, method) {


        let rewritten_path = '/api' + path.replace(/{(\w+)}/g, ':$1');

        let server_url = _.get(openapi_spec, ['servers', 0, 'url']);


        let request_validator = new OpenAPIRequestValidator(_.merge({}, _.pick(method_spec, ['parameters', 'requestBody']), {
            schemas: _.get(openapi_spec, 'components.schemas'),
            version: _.get(openapi_spec, 'openapi')
        }));
        let response_validator = new OpenAPIResponseValidator(_.merge({}, _.pick(method_spec, ['responses']), {
            definitions: _.get(openapi_spec, 'components.schemas'),
            version: _.get(openapi_spec, 'openapi')
        }));

        let handler = function (req, res, next) {
            let request_errors = request_validator.validate({
                body: req.body,
                params: req.params,
                query: req.query
            });

            if (!_.isEmpty(request_errors)) {
                return next(request_errors);
            }


            let rewritten_url = server_url + req.url.replace(/^\/api(\/.*)$/, '$1');

            return Promise.resolve(axios({
                method: method,
                url: rewritten_url,
                data: req.body
            }))
                .then(function (response) {

                    let response_errors = response_validator.validateResponse(response.status, response.data);

                    if (!_.isEmpty(response_errors)) {
                        return next(response_errors);
                    }

                    return res.status(response.status).jsonp(response.data);
                })
                .catch(function (err) {
                    return next(err);
                })
        };


        app[method](rewritten_path, handler);

        console.log(`Registered ${rewritten_path}`)


    });
});


app.use(function (req, res, next) {
    let error = new Error('Not Found');
    error.status = 404;
    return next(error);
});

app.use(function (err, req, res) {

    console.error(err.stack);

    res.status(err.status || 500);
    return res.jsonp({
        status: err.status || 500,
        message: err.message
    });

});

let server;
if (!_.isNil(https_config)) {
    server = https.createServer(https_config, app);
} else {
    server = http.createServer(app);
}

server.listen(port, function () {
    console.log(`Listening on port ${port}`);
});