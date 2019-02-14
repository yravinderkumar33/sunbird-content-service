/**
 * @name : contentService.js
 * @description :: Responsible for handle content service
 * @author      :: Anuj Gupta
 */

var async = require('async')
var multiparty = require('multiparty')
var fs = require('fs')
var randomString = require('randomstring')
var path = require('path')
var contentProvider = require('sb_content_provider_util')
var respUtil = require('response_util')
var LOG = require('sb_logger_util')
var logger = require('sb_logger_util_v2')
var validatorUtil = require('sb_req_validator_util')
var _ = require('underscore')
var lodash = require('lodash')

var contentModel = require('../models/contentModel').CONTENT
var messageUtils = require('./messageUtil')
var utilsService = require('../service/utilsService')
var emailService = require('./emailService')
var orgHelper = require('../helpers/orgHelper')

var CacheManager = require('sb_cache_manager')
var cacheManager = new CacheManager({})

var filename = path.basename(__filename)
var contentMessage = messageUtils.CONTENT
var compositeMessage = messageUtils.COMPOSITE
var responseCode = messageUtils.RESPONSE_CODE
var reqMsg = messageUtils.REQUEST

/**
 * This function helps to generate code for create course
 * @returns {String}
 */
function getCode () {
  return contentMessage.PREFIX_CODE + randomString.generate(6)
}

/**
 * This function return the mimeType for create course
 * @returns {String}
 */
// function getMimeTypeForContent () {
//   return contentMessage.MIME_TYPE
// }

/**
 * This function return the contentType for create course
 * @returns {String}
 */
function getContentTypeForContent () {
  return contentMessage.CONTENT_TYPE
}

function searchAPI (req, response) {
  return search(compositeMessage.CONTENT_TYPE, req, response)
}

function searchContentAPI (req, response) {
  return search(getContentTypeForContent(), req, response, ['Content'])
}

// This function used for performance log
// function logs (isPLogs, startTime, rspObj, level, file, method, message, data, stacktrace) {
//   if (isPLogs) {
//     LOG.info(utilsService.getPerfLoggerData(rspObj, 'INFO', file, method,
//       'Time taken in ms', {timeInMs: Date.now() - csApiStart}))
//   }
// }

function search (defaultContentTypes, req, response, objectType) {
  var data = req.body
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.search() called', additionalInfo: { body: data, rspObj }
  }, req)

  if (!data.request || !data.request.filters) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchContentAPI',
      'Error due to required params are missing', data.request))

    rspObj.errCode = contentMessage.SEARCH.MISSING_CODE
    rspObj.errMsg = contentMessage.SEARCH.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR

    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)

    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  if (!data.request.filters) {
    data.request.filters.contentType = defaultContentTypes
  }

  // if fields exists it has to be sent as array to lp
  if (req.query.fields) {
    data.request.fields = req.query.fields.split(',')
  }
  if (objectType) {
    data.request.filters.objectType = objectType
  }
  //    if(!data.request.filters.mimeType) {
  //        data.request.filters.mimeType = getMimeTypeForContent();
  //    }

  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchContentAPI',
        'Request to content provider to search the content', {
          body: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to search the content',
        additionalInfo: {
          body: ekStepReqData
        }
      }, req)

      contentProvider.compositeSearch(ekStepReqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.SEARCH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.SEARCH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              err,
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          if (req.query.framework) {
            getFrameworkDetails(req, function (err, data) {
              if (err || res.responseCode !== responseCode.SUCCESS) {
                LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'Framework API failed',
                  'Framework API failed with framework - ' + req.query.framework, { 'err': err, 'res': res }))

                logger.error({ msg: `Framework API failed with framework - ${req.query.framework}`, err, res }, req)
                rspObj.result = res.result
                return response.status(200).send(respUtil.successResponse(rspObj))
              } else {
                var language = req.query.lang ? req.query.lang : 'en'
                if (lodash.get(res, 'result.facets') &&
                  lodash.get(data, 'result.framework.categories')) {
                  modifyFacetsData(res.result.facets, data.result.framework.categories, language)
                }
                orgHelper.includeOrgDetails(req, res, CBW)
              }
            })
          } else {
            orgHelper.includeOrgDetails(req, res, CBW)
          }
        }
      })
    },

    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchContentAPI',
        'Content searched successfully, We got ' + rspObj.result.count + ' results', {
          contentCount: rspObj.result.count
        }))
      logger.info({
        msg: `Content searched successfully with ${rspObj.result.count}`,
        additionalInfo: {
          contentCount: rspObj.result.count
        }
      }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function getFrameworkDetails (req, CBW) {
  cacheManager.get(req.query.framework, function (err, data) {
    if (err || !data) {
      contentProvider.getFrameworkById(req.query.framework, '', req.headers, function (err, result) {
        if (err || result.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(req.rspObj, 'ERROR', filename, 'framework API failed',
            'Fetching framework data failed' + req.query.framework, err))
          logger.error({ msg: `Fetching framework data failed ${req.query.framework}`, err }, req)
          CBW(new Error('Fetching framework data failed'), null)
        } else {
          LOG.info(utilsService.getLoggerData(req.rspObj, 'INFO', filename, 'framework API success',
            'Fetching framework data success - ' + req.query.framework, result))
          logger.info({ msg: `Fetching framework data success ${req.query.framework}`, res: result }, req)
          cacheManager.set({ key: req.query.framework, value: result },
            function (err, data) {
              if (err) {
                LOG.error(utilsService.getLoggerData(req.rspObj, 'ERROR', filename, 'Setting framework cache failed',
                  'Setting framework cache data failed' + req.query.framework, err))
                logger.error({ msg: `Setting framework cache data failed ${req.query.framework}`, err }, req)
              } else {
                LOG.info(utilsService.getLoggerData(req.rspObj, 'INFO', filename,
                  'Setting framework cache data success',
                  'Setting framework cache data success - ' + req.query.framework, result))
                logger.info({ msg: `Setting framework cache data success ${req.query.framework}`, res: result }, req)
              }
            })
          CBW(null, result)
        }
      })
    } else {
      CBW(null, data)
    }
  })
}

function modifyFacetsData (searchData, frameworkData, language) {
  lodash.forEach(searchData, (facets) => {
    lodash.forEach(frameworkData, (categories) => {
      if (categories.code === facets.name) {
        lodash.forEach(facets.values, (values) => {
          lodash.forEach(categories.terms, (terms) => {
            if (values.name.toLowerCase() === terms.name.toLowerCase()) {
              terms = lodash.pick(terms, ['name', 'translations', 'description',
                'index', 'count'])
              Object.assign(values, terms)
              values.translations = parseTranslationData(terms.translations, language)
            }
          })
        })
        facets.values = lodash.orderBy(facets.values, ['index'], ['asc'])
      }
    })
  })
}

function parseTranslationData (data, language) {
  try {
    return lodash.get(JSON.parse(data), language) || null
  } catch (e) {
    console.warn(e)
    return null
  }
}

/**
 * This function helps to create content and create course in ekStep course
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with htpp status
 */
function createContentAPI (req, response) {
  var data = req.body
  var rspObj = req.rspObj

  if (!data.request || !data.request.content || !validatorUtil.validate(data.request.content, contentModel.CREATE)) {
    // prepare
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'createContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.CREATE.MISSING_CODE
    rspObj.errMsg = contentMessage.CREATE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR

    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Ek step
  data.request.content.code = getCode()
  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'createContentAPI',
        'Request to content provider to create content', {
          body: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to create content',
        additionalInfo: { body: ekStepReqData }
      }, req)
      contentProvider.createContent(ekStepReqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'createContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.CREATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.CREATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result.content_id = res.result.node_id
      rspObj.result.versionKey = res.result.versionKey
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'createContentAPI',
        'Sending response back to user', rspObj))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
      return response.status(200).send(respUtil.successResponse(rspObj))
    }

  ])
}

/**
 * This function helps to update content and update course in ekStep course
 * @param {type} req
 * @param {type} response
 * @returns {unresolved}
 */
function updateContentAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId

  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.updateContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.request || !data.request.content || !validatorUtil.validate(data.request.content, contentModel.UPDATE)) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.UPDATE.MISSING_CODE
    rspObj.errMsg = contentMessage.UPDATE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([

    function (CBW) {
      var qs = {
        mode: 'edit',
        fields: 'versionKey'
      }
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updateContentAPI',
        'Request to content provider to get the latest version key', {
          contentId: data.contentId,
          query: qs,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to get the latest version key',
        additionalInfo: {
          contentId: data.contentId,
          query: qs,
          headers: req.headers
        }
      }, req)
      contentProvider.getContentUsingQuery(data.contentId, qs, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPDATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPDATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          data.request.content.versionKey = res.result.content.versionKey
          CBW()
        }
      })
    },
    function (CBW) {
      var ekStepReqData = {
        request: data.request
      }
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updateContentAPI',
        'Request to content provider to update the content', {
          body: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to update the content',
        additionalInfo: {
          body: ekStepReqData
        }
      }, req)
      contentProvider.updateContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPDATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPDATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },

    function (res) {
      rspObj.result.content_id = res.result.node_id
      rspObj.result.versionKey = res.result.versionKey
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updateContentAPI',
        'Sending response back to user', rspObj))
      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function uploadContentAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  data.queryParams = req.query
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.uploadContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)

  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.queryParams.fileUrl) {
    var form = new multiparty.Form()

    form.parse(req, function (err, fields, files) {
      if (err || (files && Object.keys(files).length === 0)) {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'uploadContentAPI',
          'Error due to upload files are missing', {
            contentId: data.contentId,
            files: files
          }))
        rspObj.errCode = contentMessage.UPLOAD.MISSING_CODE
        rspObj.errMsg = contentMessage.UPLOAD.MISSING_MESSAGE
        rspObj.responseCode = responseCode.CLIENT_ERROR

        logger.error({
          msg: 'Error due to upload files are missing',
          additionalInfo: {
            contentId: data.contentId,
            files: files
          },
          err: {
            errCode: rspObj.errCode,
            errMsg: rspObj.errMsg,
            responseCode: rspObj.responseCode
          }
        }, req)
        return response.status(400).send(respUtil.errorResponse(rspObj))
      }
    })

    form.on('file', function (name, file) {
      var formData = {
        file: {
          value: fs.createReadStream(file.path),
          options: {
            filename: file.originalFilename
          }
        }
      }
      async.waterfall([

        function (CBW) {
          LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentAPI',
            'Request to content provider to upload the content', {
              contentId: data.contentId,
              headers: req.headers
            }))

          logger.info({
            msg: 'Request to content provider to upload the content',
            additionalInfo: {
              contentId: data.contentId,
              headers: req.headers
            }
          }, req)

          delete req.headers['content-type']
          contentProvider.uploadContent(formData, data.contentId, req.headers, function (err, res) {
            if (err || res.responseCode !== responseCode.SUCCESS) {
              LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'uploadContentAPI',
                'Getting error from content provider', res))
              rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPLOAD.FAILED_CODE
              rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPLOAD.FAILED_MESSAGE
              rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
              logger.error({
                msg: 'Getting error from content provider',
                err: {
                  errCode: rspObj.errCode,
                  errMsg: rspObj.errMsg,
                  responseCode: rspObj.responseCode
                },
                res
              }, req)
              var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
              rspObj = utilsService.getErrorResponse(rspObj, res)
              return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
            } else {
              CBW(null, res)
            }
          })
        },
        function (res) {
          rspObj.result = res.result
          LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentAPI',
            'Sending response back to user', rspObj))

          logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

          var modifyRsp = respUtil.successResponse(rspObj)
          modifyRsp.success = true
          return response.status(200).send(modifyRsp)
        }
      ])
    })
  } else {
    var queryString = { fileUrl: data.queryParams.fileUrl }
    async.waterfall([

      function (CBW) {
        LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentAPI',
          'Request to content provider to upload the content', {
            contentId: data.contentId,
            headers: req.headers
          }))

        logger.info({
          msg: 'Request to content provider to upload the content',
          additionalInfo: {
            contentId: data.contentId,
            headers: req.headers
          }
        }, req)

        delete req.headers['content-type']
        contentProvider.uploadContentWithFileUrl(data.contentId, queryString, req.headers, function (err, res) {
          if (err || res.responseCode !== responseCode.SUCCESS) {
            LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'uploadContentAPI',
              'Getting error from content provider', res))
            rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPLOAD.FAILED_CODE
            rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPLOAD.FAILED_MESSAGE
            rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR

            logger.error({
              msg: 'Getting error from content provider',
              err: {
                errCode: rspObj.errCode,
                errMsg: rspObj.errMsg,
                responseCode: rspObj.responseCode
              },
              res
            }, req)

            var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
            rspObj = utilsService.getErrorResponse(rspObj, res)
            return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
          } else {
            CBW(null, res)
          }
        })
      },
      function (res) {
        rspObj.result = res.result
        LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentAPI',
          'Sending response back to user', rspObj))
        logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
        var modifyRsp = respUtil.successResponse(rspObj)
        modifyRsp.success = true
        return response.status(200).send(modifyRsp)
      }
    ])
  }
}

function reviewContentAPI (req, response) {
  LOG.info(utilsService.getLoggerData(req.rspObj, 'INFO', filename, 'reviewContentAPI call came',
    'Request for review came', null))
  logger.info({ msg: 'Request for review came' }, req)

  var data = {
    body: req.body
  }
  data.contentId = req.params.contentId
  var ekStepReqData = {
    request: data.request
  }

  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.reviewContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'reviewContentAPI',
        'Request to content provider to review the content', {
          req: ekStepReqData,
          contentId: data.contentId,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to review the content',
        additionalInfo: {
          req: ekStepReqData,
          contentId: data.contentId,
          headers: req.headers
        }
      }, req)
      contentProvider.reviewContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        // After check response, we perform other operation
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'reviewContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.REVIEW.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.REVIEW.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result.content_id = res.result.node_id
      rspObj.result.versionKey = res.result.versionKey
      emailService.reviewContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'reviewContentAPI',
        'Sending response back to user', rspObj))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function publishContentAPI (req, response) {
  var data = req.body
  var rspObj = req.rspObj
  data.contentId = req.params.contentId
  var ekStepReqData = {
    request: data.request
  }

  logger.debug({
    msg: 'contentService.publishContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)

  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.request || !data.request.content || !data.request.content.lastPublishedBy) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'publishContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.PUBLISH.MISSING_CODE
    rspObj.errMsg = contentMessage.PUBLISH.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'publishContentAPI',
        'Request to content provider to publish the content', {
          contentId: data.contentId,
          reqData: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to publish the content',
        additionalInfo: {
          contentId: data.contentId,
          reqData: ekStepReqData,
          headers: req.headers
        }
      }, req)

      contentProvider.publishContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        // After check response, we perform other operation
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'publishContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.PUBLISH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.PUBLISH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result.content_id = res.result.node_id
      rspObj.result.versionKey = res.result.versionKey
      rspObj.result.publishStatus = res.result.publishStatus
      emailService.publishedContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'publishContentAPI',
        'Sending response back to user', rspObj))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function getContentAPI (req, response) {
  var data = {}
  data.body = req.body
  data.contentId = req.params.contentId
  data.queryParams = req.query
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.getContentAPI() called', additionalInfo: { body: data, rspObj }
  }, req)

  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.contentId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getContentAPI',
      'Error due to required params are missing', {
        contentId: data.contentId
      }))
    rspObj.errCode = contentMessage.GET.MISSING_CODE
    rspObj.errMsg = contentMessage.GET.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      },
      additionalInfo: {
        contentId: data.contentId
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getContentAPI',
        'Request to content provider to get the content meta data', {
          contentId: data.contentId,
          qs: data.queryParams,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to get the content meta data',
        additionalInfo: {
          contentId: data.contentId,
          qs: data.queryParams,
          headers: req.headers
        }
      }, req)
      contentProvider.getContentUsingQuery(data.contentId, data.queryParams, req.headers, function (err, res) {
        // After check response, we perform other operation
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res, CBW) {
      orgHelper.includeOrgDetails(req, res, CBW)
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getContentAPI', 'Sending response back to user'))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function getMyContentAPI (req, response) {
  var request = {
    'filters': {
      // "createdBy": req.userId
      'createdBy': req.params.createdBy,
      'contentType': getContentTypeForContent()
    }

  }
  req.body.request = request
  var ekStepReqData = {
    request: request
  }
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.getMyContentAPI() called', additionalInfo: { request, rspObj }
  }, req)

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getMyContentAPI',
        'Request to content provider to get user content', {
          body: ekStepReqData,
          headers: req.headers
        }))
      logger.info({
        msg: 'Request to content provider to get user content',
        additionalInfo: {
          body: ekStepReqData,
          headers: req.headers
        }
      }, req)
      contentProvider.compositeSearch(ekStepReqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getMyContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET_MY.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET_MY.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getMyContentAPI',
        'My Content searched successfully, We got ' + rspObj.result.count + ' results', {
          courseCount: rspObj.result.count
        }))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function retireContentAPI (req, response) {
  var data = req.body
  var rspObj = req.rspObj
  var failedContent = []
  var userId = req.headers['x-authenticated-userid']
  var errCode, errMsg, respCode, httpStatus

  logger.debug({
    msg: 'contentService.retireContentAPI() called', additionalInfo: { body: data, rspObj }
  }, req)

  if (!data.request || !data.request.contentIds) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'retireContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.RETIRE.MISSING_CODE
    rspObj.errMsg = contentMessage.RETIRE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([

    function (CBW) {
      var ekStepReqData = {
        request: {
          search: {
            identifier: data.request.contentIds
          }
        }
      }
      contentProvider.searchContent(ekStepReqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.SEARCH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.SEARCH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },

    function (res, CBW) {
      var createdByOfContents = _.uniq(_.pluck(res.result.content, 'createdBy'))
      if (createdByOfContents.length === 1 && createdByOfContents[0] === userId) {
        CBW()
      } else {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'retireContentAPI',
          'Content createdBy and userId field not matched'))
        rspObj.errCode = reqMsg.TOKEN.INVALID_CODE
        rspObj.errMsg = reqMsg.TOKEN.INVALID_MESSAGE
        rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS
        return response.status(401).send(respUtil.errorResponse(rspObj))
      }
    },

    function (CBW) {
      async.each(data.request.contentIds, function (contentId, CBE) {
        LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'retireContentAPI',
          'Request to content provider to retire content', {
            contentId: contentId,
            headers: req.headers
          }))
        logger.info({
          msg: 'Request to content provider to retire content',
          additionalInfo: {
            contentId: contentId,
            headers: req.headers
          }
        }, req)

        // Adding objectData in telemetry
        if (rspObj.telemetryData) {
          rspObj.telemetryData.object = utilsService.getObjectData(contentId, 'content', '', {})
        }
        contentProvider.retireContent(contentId, req.headers, function (err, res) {
          if (err || res.responseCode !== responseCode.SUCCESS) {
            LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'retireContentAPI',
              'Getting error from content provider', res))
            errCode = res && res.params ? res.params.err : contentMessage.GET_MY.FAILED_CODE
            errMsg = res && res.params ? res.params.errmsg : contentMessage.GET_MY.FAILED_MESSAGE
            respCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
            logger.error({
              msg: 'Getting error from content provider',
              err: {
                errCode: rspObj.errCode,
                errMsg: rspObj.errMsg,
                responseCode: rspObj.responseCode
              },
              res
            }, req)
            httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
            failedContent.push({ contentId: contentId, errCode: errCode, errMsg: errMsg })
          }
          CBE(null, null)
        })
      }, function () {
        if (failedContent.length > 0) {
          rspObj.errCode = errCode
          rspObj.errMsg = errMsg
          rspObj.responseCode = respCode
          rspObj.result = failedContent
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW()
        }
      })
    },
    function () {
      rspObj.result = failedContent
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'retireContentAPI',
        'Sending response back to user'))
      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function rejectContentAPI (req, response) {
  var data = {
    body: req.body
  }
  data.contentId = req.params.contentId
  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.rejectContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.contentId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'rejectContentAPI',
      'Error due to required params are missing', {
        contentId: data.contentId
      }))
    rspObj.errCode = contentMessage.REJECT.MISSING_CODE
    rspObj.errMsg = contentMessage.REJECT.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  var ekStepReqData = {
    request: data.body.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'rejectContentAPI',
        'Request to content provider to reject content', {
          contentId: data.contentId,
          headers: req.headers
        }))
      logger.info({
        msg: 'Request to content provider to reject content',
        additionalInfo: {
          contentId: data.contentId,
          headers: req.headers
        }
      }, req)
      contentProvider.rejectContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'rejectContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.REJECT.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.REJECT.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      emailService.rejectContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'rejectContentAPI',
        'Sending response back to user'))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function flagContentAPI (req, response) {
  // var data = req.body
  // data.contentId = req.params.contentId
  // var rspObj = req.rspObj
  // // Adding objectData in telemetry
  // if (rspObj.telemetryData) {
  //   rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  // }

  // if (!data.contentId || !data.request || !data.request.flaggedBy || !data.request.versionKey) {
  //   LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'flagContentAPI',
  //     'Error due to required params are missing', {
  //       contentId: data.contentId
  //     }))
  //   rspObj.errCode = contentMessage.FLAG.MISSING_CODE
  //   rspObj.errMsg = contentMessage.FLAG.MISSING_MESSAGE
  //   rspObj.responseCode = responseCode.CLIENT_ERROR
  //   return response.status(400).send(respUtil.errorResponse(rspObj))
  // }
  // var ekStepReqData = {
  //   request: data.request
  // }

  // async.waterfall([

  //   function (CBW) {
  //     LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'flagContentAPI',
  //       'Request to content provider to flag the content', {
  //         contentId: data.contentId,
  //         body: ekStepReqData,
  //         headers: req.headers
  //       }))
  //     contentProvider.flagContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
  //       if (err || res.responseCode !== responseCode.SUCCESS) {
  //         LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'flagContentAPI',
  //           'Getting error from content provider', res))
  //         rspObj.errCode = res && res.params ? res.params.err : contentMessage.FLAG.FAILED_CODE
  //         rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.FLAG.FAILED_MESSAGE
  //         rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
  //         var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
  //         rspObj = utilsService.getErrorResponse(rspObj, res)
  //         return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
  //       } else {
  //         CBW(null, res)
  //       }
  //     })
  //   },
  //   function (res) {
  //     rspObj.result = res.result
  //     emailService.createFlagContentEmail(req, function () { })
  //     LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'flagContentAPI',
  //       'Sending response back to user'))
  //     return response.status(200).send(respUtil.successResponse(rspObj))
  //   }
  // ])
  return response.status(200).send(respUtil.successResponse({}))
}

function acceptFlagContentAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.acceptFlagContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.contentId || !data.request) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'acceptFlagContentAPI',
      'Error due to required params are missing', {
        contentId: data.contentId
      }))
    rspObj.errCode = contentMessage.ACCEPT_FLAG.MISSING_CODE
    rspObj.errMsg = contentMessage.ACCEPT_FLAG.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      },
      additionalInfo: {
        contentId: data.contentId
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'acceptFlagContentAPI',
        'Request to content provider to accept flag', {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }))
      logger.info({
        msg: 'Request to content provider to accept flag',
        additionalInfo: {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }
      }, req)

      contentProvider.acceptFlagContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'acceptFlagContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.ACCEPT_FLAG.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.ACCEPT_FLAG.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      emailService.acceptFlagContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'acceptFlagContentAPI',
        'Sending response back to user'))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function rejectFlagContentAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.rejectFlagContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.contentId || !data.request) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'rejectFlagContentAPI',
      'Error due to required params are missing', {
        contentId: data.contentId
      }))
    rspObj.errCode = contentMessage.REJECT_FLAG.MISSING_CODE
    rspObj.errMsg = contentMessage.REJECT_FLAG.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      },
      additionalInfo: {
        contentId: data.contentId
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'rejectFlagContentAPI',
        'Request to content provider to reject flag', {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to reject flag',
        additionalInfo: {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }
      }, req)

      contentProvider.rejectFlagContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'rejectFlagContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.REJECT_FLAG.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.REJECT_FLAG.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      emailService.rejectFlagContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'rejectFlagContentAPI',
        'Sending response back to user'))
      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function uploadContentUrlAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.uploadContentUrlAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data.contentId || !data.request || !data.request.content || !data.request.content.fileName) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'uploadContentUrlAPI',
      'Error due to required params are missing', {
        contentId: data.contentId,
        body: data
      }))
    rspObj.errCode = contentMessage.UPLOAD_URL.MISSING_CODE
    rspObj.errMsg = contentMessage.UPLOAD_URL.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      },
      additionalInfo: {
        contentId: data.contentId,
        body: data
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentUrlAPI',
        'Request to content provider to get upload content url', {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider get upload content url',
        additionalInfo: {
          contentId: data.contentId,
          body: ekStepReqData,
          headers: req.headers
        }
      }, req)
      contentProvider.uploadContentUrl(ekStepReqData, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'uploadContentUrlAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPLOAD_URL.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPLOAD_URL.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'uploadContentUrlAPI',
        'Sending response back to user'))
      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      var modifyRsp = respUtil.successResponse(rspObj)
      modifyRsp.success = true
      return response.status(200).send(modifyRsp)
    }
  ])
}

function unlistedPublishContentAPI (req, response) {
  var data = req.body
  var rspObj = req.rspObj
  data.contentId = req.params.contentId
  logger.debug({
    msg: 'contentService.unlistedPublishContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)
  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  var ekStepReqData = {
    request: data.request
  }

  if (!data.request || !data.request.content || !data.request.content.lastPublishedBy) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'unlistedPublishContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.UNLISTED_PUBLISH.MISSING_CODE
    rspObj.errMsg = contentMessage.UNLISTED_PUBLISH.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'unlistedPublishContentAPI',
        'Request to content provider to unlisted published the content', {
          contentId: data.contentId,
          reqData: ekStepReqData,
          headers: req.headers
        }))

      logger.info({
        msg: 'Request to content provider to unlisted published the content',
        additionalInfo: {
          contentId: data.contentId,
          reqData: ekStepReqData,
          headers: req.headers
        }
      }, req)
      contentProvider.unlistedPublishContent(ekStepReqData, data.contentId, req.headers, function (err, res) {
        // After check response, we perform other operation
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'unlistedPublishContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UNLISTED_PUBLISH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UNLISTED_PUBLISH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result.content_id = res.result.node_id
      rspObj.result.versionKey = res.result.versionKey
      rspObj.result.publishStatus = res.result.publishStatus
      emailService.unlistedPublishContentEmail(req, function () { })
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'unlistedPublishContentAPI',
        'Sending response back to user', rspObj))

      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function assignBadge (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.assignBadge() called', additionalInfo: { body: data, contentId: req.params.contentId, rspObj }
  }, req)
  if (!data.request || !data.request.content || !data.request.content.badgeAssertion) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'assignBadgeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.ASSIGN_BADGE.MISSING_CODE
    rspObj.errMsg = contentMessage.ASSIGN_BADGE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([function (CBW) {
    LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'assignBadgeAPI',
      'Request to content provider to get the content meta data', {
        contentId: data.contentId,
        qs: data.queryParams,
        headers: req.headers
      }))
    logger.info({
      msg: 'Request to content provider to  get the content meta data',
      additionalInfo: {
        contentId: data.contentId,
        qs: data.queryParams,
        headers: req.headers
      }
    }, req)
    contentProvider.getContent(data.contentId, req.headers, function (err, res) {
      if (err || res.responseCode !== responseCode.SUCCESS) {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'assignBadgeAPI',
          'Getting error from content provider', res))
        rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE
        rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE
        rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
        logger.error({
          msg: 'Getting error from content provider',
          err: {
            errCode: rspObj.errCode,
            errMsg: rspObj.errMsg,
            responseCode: rspObj.responseCode
          },
          res
        }, req)
        var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
        rspObj = utilsService.getErrorResponse(rspObj, res)
        return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
      } else {
        CBW(null, res)
      }
    })
  }, function (content, CBW) {
    var badgeAssertions = content.result.content.badgeAssertions
    var badges = badgeAssertions || []
    var newBadge = data.request.content.badgeAssertion
    var isBadgeExists = false

    lodash.forEach(badges, function (badge) {
      if (badge.assertionId === newBadge.assertionId &&
        badge.badgeId === newBadge.badgeId &&
        badge.issuerId === newBadge.issuerId) {
        isBadgeExists = true
      }
    })
    if (isBadgeExists === true) {
      rspObj.result = rspObj.result || {}
      rspObj.result.content = rspObj.result.content || {}
      rspObj.result.content.message = 'badge already exist'
      rspObj.responseCode = 'CONFLICT'
      return response.status(409).send(respUtil.successResponse(rspObj))
    } else {
      badges.push(newBadge)
      var requestBody = {
        'request': {
          'content': {
            'badgeAssertions': badges
          }
        }
      }
      contentProvider.systemUpdateContent(requestBody, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPDATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPDATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    }
  }, function (res) {
    LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'assignBadgeAPI', 'Sending response back to user'))
    rspObj.result = res.result
    logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
    return response.status(200).send(respUtil.successResponse(rspObj))
  }])
}

function revokeBadge (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj
  logger.debug({
    msg: 'contentService.revokeBadge() called', additionalInfo: { body: data, contentId: req.params.contentId, rspObj }
  }, req)
  if (!data.request || !data.request.content || !data.request.content.badgeAssertion) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'revokeBadgeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.REVOKE_BADGE.MISSING_CODE
    rspObj.errMsg = contentMessage.REVOKE_BADGE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  async.waterfall([function (CBW) {
    LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'revokeBadgeAPI',
      'Request to content provider to get the content meta data', {
        contentId: data.contentId,
        qs: data.queryParams,
        headers: req.headers
      }))
    logger.info({
      msg: 'Request to content provider to  get the content meta data',
      additionalInfo: {
        contentId: data.contentId,
        qs: data.queryParams,
        headers: req.headers
      }
    }, req)

    contentProvider.getContent(data.contentId, req.headers, function (err, res) {
      if (err || res.responseCode !== responseCode.SUCCESS) {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'revokeBadgeAPI',
          'Getting error from content provider', res))
        rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE
        rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE
        rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
        logger.error({
          msg: 'Getting error from content provider',
          err: {
            errCode: rspObj.errCode,
            errMsg: rspObj.errMsg,
            responseCode: rspObj.responseCode
          },
          res
        }, req)
        var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
        rspObj = utilsService.getErrorResponse(rspObj, res)
        return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
      } else {
        CBW(null, res)
      }
    })
  }, function (content, CBW) {
    var badgeAssertions = content.result.content.badgeAssertions
    var badges = badgeAssertions || []
    var revokeBadge = lodash.cloneDeep(data.request.content.badgeAssertion)
    delete data.request.content.badgeAssertion
    var isbadgeExists = false

    lodash.remove(badges, function (badge) {
      if (badge.assertionId === revokeBadge.assertionId) {
        isbadgeExists = true
        return true
      }
    })
    if (isbadgeExists === false) {
      rspObj.result = rspObj.result || {}
      rspObj.result.content = rspObj.result.content || {}
      rspObj.result.content.message = 'badge not exist'
      return response.status(404).send(respUtil.successResponse(rspObj))
    } else {
      var requestBody = {
        'request': {
          'content': {
            'badgeAssertions': badges
          }
        }
      }
      contentProvider.systemUpdateContent(requestBody, data.contentId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.UPDATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.UPDATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    }
  }, function (res) {
    LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'revokeBadgeAPI', 'Sending response back to user'))
    rspObj.result = res.result
    logger.info({ msg: 'Sending response back to user', res: rspObj }, req)
    return response.status(200).send(respUtil.successResponse(rspObj))
  }])
}

/**
 * This function helps to copy content
 * @param {type} req
 * @param {type} response
 * @returns {unresolved}
 */
function copyContentAPI (req, response) {
  var data = req.body
  data.contentId = req.params.contentId
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.copyContentAPI() called',
    additionalInfo: {
      body: data,
      contentId: req.params.contentId,
      rspObj
    }
  }, req)

  // Adding objectData in telemetry
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.contentId, 'content', '', {})
  }

  if (!data['contentId']) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateContentAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = contentMessage.COPY.MISSING_CODE
    rspObj.errMsg = contentMessage.COPY.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  var ekStepReqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'copyContentAPI',
        'Request to content provider to copy content', {
          body: ekStepReqData,
          headers: req.headers
        }))
      logger.info({
        msg: 'Request to content provider to  to copy content',
        additionalInfo: {
          body: ekStepReqData,
          headers: req.headers
        }
      }, req)
      contentProvider.copyContent(ekStepReqData, data['contentId'], req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'copyContentAPI',
            'copy content error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.COPY.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.COPY.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'copyContentAPI',
        'Sending response back to user', rspObj))
      logger.info({ msg: 'Sending response back to user', res: rspObj }, req)

      return response.status(200).send(respUtil.successResponse(rspObj))
    }

  ])
}

function searchPluginsAPI (req, response, objectType) {
  var data = req.body
  var rspObj = req.rspObj

  logger.debug({
    msg: 'contentService.searchPluginsAPI() called', additionalInfo: { body: data, rspObj }
  }, req)

  if (!data.request || !data.request.filters) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchContentAPI',
      'Error due to required params are missing', data.request))

    rspObj.errCode = contentMessage.SEARCH_PLUGINS.MISSING_CODE
    rspObj.errMsg = contentMessage.SEARCH_PLUGINS.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    logger.error({
      msg: 'Error due to required params are missing',
      err: {
        errCode: rspObj.errCode,
        errMsg: rspObj.errMsg,
        responseCode: rspObj.responseCode
      }
    }, req)
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  data.request.filters.objectType = ['content']
  data.request.filters.contentType = ['plugin']

  var requestData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchPluginsAPI',
        'Request to content provider to search the plugins', {
          body: requestData,
          headers: req.headers
        }))
      logger.info({
        msg: 'Request to content provider to search the plugins',
        additionalInfo: {
          body: requestData,
          headers: req.headers
        }
      }, req)
      contentProvider.pluginsSearch(requestData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchPluginsAPI',
            'Getting error from content provider', res))
          rspObj.errCode = res && res.params ? res.params.err : contentMessage.SEARCH_PLUGINS.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.SEARCH_PLUGINS.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          logger.error({
            msg: 'Getting error from content provider',
            err: {
              errCode: rspObj.errCode,
              errMsg: rspObj.errMsg,
              responseCode: rspObj.responseCode
            },
            res
          }, req)
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },

    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchPluginsAPI',
        'Content searched successfully, We got ' + rspObj.result.count + ' results', {
          contentCount: rspObj.result.count
        }))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function validateContentLock (req, response) {
  var rspObj = req.rspObj
  var userId = req.get('x-authenticated-userid')
  logger.debug({
    msg: 'contentService.validateContentLock() called', additionalInfo: { userId, rspObj }
  }, req)
  var qs = {
    mode: 'edit'
  }
  contentProvider.getContentUsingQuery(req.body.request.resourceId, qs, req.headers, function (err, res) {
    if (err) {
      LOG.error(utilsService.getLoggerData(req.rspObj, 'ERROR', filename, 'validateContentLock',
        'Getting content details failed', err))
      rspObj.result.validation = false
      rspObj.result.message = 'Unable to fetch content details'
      logger.error({ msg: 'Getting content details failed', err: { err, errMsg: rspObj.result.message } }, req)
      return response.status(500).send(respUtil.errorResponse(rspObj))
    } else if (res && res.responseCode !== responseCode.SUCCESS) {
      LOG.error(utilsService.getLoggerData(req.rspObj, 'ERROR', filename, 'validateContentLock',
        'Getting content details failed', res))
      rspObj.result.validation = false
      rspObj.result.message = res.params.errmsg
      logger.error({ msg: 'Getting content details failed', err: { errMsg: rspObj.result.message }, res }, req)
      return response.status(500).send(respUtil.errorResponse(rspObj))
    } else {
      LOG.info(utilsService.getLoggerData(req.rspObj, 'INFO', filename, 'validateContentLock',
        'Getting content details success', res))
      logger.info({ msg: 'Getting content details success', res }, req)
      if (res.result.content.status !== 'Draft' && req.body.request.apiName !== 'retireLock') {
        rspObj.result.validation = false
        rspObj.result.message = 'The operation cannot be completed as content is not in draft state'
        logger.warn({ msg: 'The operation cannot be completed as content is not in draft state' }, req)
        return response.status(200).send(respUtil.successResponse(rspObj))
      } else if (res.result.content.createdBy !== userId &&
        !lodash.includes(res.result.content.collaborators, userId)) {
        rspObj.result.validation = false
        rspObj.result.message = 'You are not authorized'
        logger.error({
          msg: 'You are not authorized', err: { errMsg: rspObj.result.message }
        }, req)
        return response.status(200).send(respUtil.successResponse(rspObj))
      } else {
        rspObj.result.validation = true
        rspObj.result.message = 'Content successfully validated'
        rspObj.result.contentdata = res.result.content
        logger.info({ msg: 'Content successfully validated' }, req)
        return response.status(200).send(respUtil.successResponse(rspObj))
      }
    }
  })
}

module.exports.searchAPI = searchAPI
module.exports.searchContentAPI = searchContentAPI
module.exports.createContentAPI = createContentAPI
module.exports.updateContentAPI = updateContentAPI
module.exports.uploadContentAPI = uploadContentAPI
module.exports.reviewContentAPI = reviewContentAPI
module.exports.publishContentAPI = publishContentAPI
module.exports.getContentAPI = getContentAPI
module.exports.getMyContentAPI = getMyContentAPI
module.exports.retireContentAPI = retireContentAPI
module.exports.rejectContentAPI = rejectContentAPI
module.exports.flagContentAPI = flagContentAPI
module.exports.acceptFlagContentAPI = acceptFlagContentAPI
module.exports.rejectFlagContentAPI = rejectFlagContentAPI
module.exports.uploadContentUrlAPI = uploadContentUrlAPI
module.exports.unlistedPublishContentAPI = unlistedPublishContentAPI
module.exports.assignBadgeAPI = assignBadge
module.exports.revokeBadgeAPI = revokeBadge
module.exports.copyContentAPI = copyContentAPI
module.exports.searchPluginsAPI = searchPluginsAPI
module.exports.validateContentLock = validateContentLock
